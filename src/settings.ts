import { inferCapability, isCapabilitySane } from "./ai/capability";
import { DEFAULT_WORKBENCH_SETTINGS, type WorkbenchSettings } from "./workbench/config";

export type AIProtocol = "anthropic" | "openai";

/** How a model handles its own reasoning pass. `auto` leaves it to the vendor. */
export type AIThinkingMode = "auto" | "on" | "off";

/** Where a capability number came from, so the UI never pretends to know. */
export type CapabilitySource = "preset" | "probe" | "manual" | "fallback";

/**
 * What a model can physically take. These are capabilities, not preferences:
 * the plugin reads them to size a request instead of imposing its own limits.
 */
export interface AICapability {
  /** Total tokens the model accepts in one request (input + output). */
  contextWindow: number;
  /** Tokens the model can emit in one response. */
  maxOutput: number;
  source: CapabilitySource;
}

export interface AIProfile {
  id: string;
  name: string;
  protocol: AIProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Filled by preset, probe or hand — missing means "infer again". */
  capability?: AICapability;
  /** Overrides the global thinking default for this model. */
  thinking?: AIThinkingMode;
  /** Ask the provider to cache the stable prefix. Anthropic only, opt-out. */
  cache?: boolean;
}

/**
 * Knobs for how board content is fitted into a request. Kept in one object on
 * purpose: tuning density later should not require touching board code.
 */
export interface AIContextPolicy {
  /** Tokens held back for the system prompt and estimator error. */
  safetyTokens: number;
  /** Character ladder used when the board does not fit (tried in order). */
  ladder: number[];
  /** Minimum characters kept from a note, so it never loses its point. */
  noteFloorChars: number;
  /** Hard cap per note, so one long note cannot eat the whole budget. */
  noteCapChars: number;
  /** Above this many nodes the board may be analysed in batches (P1). */
  batchThreshold: number;
}

export const DEFAULT_CONTEXT_POLICY: AIContextPolicy = {
  safetyTokens: 1024,
  ladder: [2000, 800, 400, 200],
  noteFloorChars: 700,
  noteCapChars: 20000,
  batchThreshold: 80,
};

export interface VolisAISettings {
  enabled: boolean;
  activeId: string;
  profiles: AIProfile[];
  /** Default thinking mode; a profile can override it. */
  thinking: AIThinkingMode;
  /** What happens when the selection does not fit the model. */
  onOverflow: "auto" | "ask";
  /** Maximum continuation rounds for one answer. */
  continuations: number;
  policy: AIContextPolicy;
  /** @deprecated read-only, kept so old data files still load. */
  contextLimit?: number;
  /** @deprecated read-only. */
  compactThreshold?: number;
  /** @deprecated read-only. */
  maxTokens?: number;
}

/** Lightweight per-turn record of what was actually sent to the model. */
export interface AISendSnapshot {
  usedTokens: number;
  stage: "full" | "trimmed" | "partial";
  nodes: Array<{
    /** Node id from the canvas, so a restored turn can still resolve N1. */
    id: string;
    tag: string;
    label: string;
    charsSent: number;
    charsTotal: number;
    truncated: boolean;
    readable: boolean;
    note?: string;
  }>;
  notes: string[];
}

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  /** Present on assistant turns saved after this version. */
  send?: AISendSnapshot;
}

export interface StoredConversation {
  id: string;
  title: string;
  boardPath: string;
  updatedAt: number;
  messages: StoredMessage[];
  nodeIds: string[];
}

export interface VolisSettings {
  showBadge: boolean;
  badgeFormat: "date" | "full";
  boardFolder: string;
  cardFolder: string;
  ai: VolisAISettings;
  conversations: StoredConversation[];
  workbench: WorkbenchSettings;
}

export const DEFAULT_SETTINGS: VolisSettings = {
  showBadge: true,
  badgeFormat: "date",
  boardFolder: "",
  cardFolder: "",
  ai: {
    enabled: false,
    activeId: "",
    profiles: [],
    thinking: "auto",
    onOverflow: "auto",
    continuations: 3,
    policy: { ...DEFAULT_CONTEXT_POLICY },
  },
  conversations: [],
  workbench: { ...DEFAULT_WORKBENCH_SETTINGS },
};

/** Reads the active profile, or null when nothing is configured. */
export function activeProfile(ai: VolisAISettings): AIProfile | null {
  return ai.profiles.find((profile) => profile.id === ai.activeId) ?? ai.profiles[0] ?? null;
}

/**
 * Accepts both the old single-configuration shape and the new profile list, so
 * existing installs keep working without manual migration.
 */
/** Fill in workbench defaults for installs whose data.json predates it. */
export function normalizeWorkbenchSettings(raw: unknown): WorkbenchSettings {
  const value = (raw ?? {}) as Partial<WorkbenchSettings>;
  const folder = typeof value.boardFolder === "string" ? value.boardFolder.trim() : "";
  return {
    boardFolder: folder || DEFAULT_WORKBENCH_SETTINGS.boardFolder,
  };
}

export function normalizeAISettings(raw: unknown): VolisAISettings {
  const value = (raw ?? {}) as Record<string, unknown>;

  if (Array.isArray(value.profiles)) {
    const profiles = (value.profiles as AIProfile[]).map((profile) => normalizeProfile(profile));
    const activeId = typeof value.activeId === "string" ? value.activeId : "";
    const exists = profiles.some((profile) => profile.id === activeId);

    return {
      enabled: Boolean(value.enabled),
      activeId: exists ? activeId : (profiles[0]?.id ?? ""),
      profiles,
      thinking: thinkingOr(value.thinking, "auto"),
      onOverflow: value.onOverflow === "ask" ? "ask" : "auto",
      continuations: clampNumber(value.continuations, 0, 8, 3),
      policy: normalizePolicy(value.policy),
    };
  }

  const legacy = value as {
    enabled?: boolean;
    protocol?: AIProtocol;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  };

  const hasLegacy = Boolean(legacy.baseUrl || legacy.model || legacy.apiKey);
  const profile: AIProfile = {
    id: "default",
    name: legacy.model || "默认配置",
    protocol: legacy.protocol === "anthropic" ? "anthropic" : "openai",
    baseUrl: legacy.baseUrl ?? "",
    model: legacy.model ?? "",
    apiKey: legacy.apiKey ?? "",
    capability: inferCapability(legacy.model ?? ""),
    thinking: "auto",
    cache: true,
  };

  return {
    enabled: Boolean(legacy.enabled),
    activeId: hasLegacy ? profile.id : "",
    profiles: hasLegacy ? [profile] : [],
    thinking: "auto",
    onOverflow: "auto",
    continuations: 3,
    policy: { ...DEFAULT_CONTEXT_POLICY },
  };
}

/** Fills in capability and preferences for a profile saved by an older build. */
export function normalizeProfile(profile: AIProfile): AIProfile {
  const capability = isCapabilitySane(profile.capability)
    ? profile.capability
    : inferCapability(profile.model ?? "");

  return {
    ...profile,
    capability,
    thinking: thinkingOr(profile.thinking, "auto"),
    cache: profile.cache !== false,
  };
}

export function normalizePolicy(raw: unknown): AIContextPolicy {
  const value = (raw ?? {}) as Partial<AIContextPolicy>;
  const ladder = Array.isArray(value.ladder)
    ? value.ladder
        .filter((step) => typeof step === "number" && Number.isFinite(step) && step >= 0)
        .map((step) => Math.round(step))
        .sort((a, b) => b - a)
    : [];

  return {
    safetyTokens: clampNumber(value.safetyTokens, 0, 32000, DEFAULT_CONTEXT_POLICY.safetyTokens),
    ladder: ladder.length > 0 ? ladder : [...DEFAULT_CONTEXT_POLICY.ladder],
    noteFloorChars: clampNumber(
      value.noteFloorChars,
      0,
      10000,
      DEFAULT_CONTEXT_POLICY.noteFloorChars
    ),
    noteCapChars: clampNumber(
      value.noteCapChars,
      200,
      200000,
      DEFAULT_CONTEXT_POLICY.noteCapChars
    ),
    batchThreshold: clampNumber(
      value.batchThreshold,
      10,
      1000,
      DEFAULT_CONTEXT_POLICY.batchThreshold
    ),
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(max, Math.max(min, value)));
}

function thinkingOr(value: unknown, fallback: AIThinkingMode): AIThinkingMode {
  return value === "on" || value === "off" ? value : fallback;
}
