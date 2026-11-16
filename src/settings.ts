export type AIProtocol = "anthropic" | "openai";

export interface AIProfile {
  id: string;
  name: string;
  protocol: AIProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface VolisAISettings {
  enabled: boolean;
  activeId: string;
  profiles: AIProfile[];
  /** Characters of board content allowed in a single request. */
  contextLimit: number;
  /** Characters of conversation history before early turns are summarised. */
  compactThreshold: number;
}

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
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
    contextLimit: 80000,
    compactThreshold: 20000,
  },
  conversations: [],
};

/** Reads the active profile, or null when nothing is configured. */
export function activeProfile(ai: VolisAISettings): AIProfile | null {
  return ai.profiles.find((profile) => profile.id === ai.activeId) ?? ai.profiles[0] ?? null;
}

/**
 * Accepts both the old single-configuration shape and the new profile list, so
 * existing installs keep working without manual migration.
 */
export function normalizeAISettings(raw: unknown): VolisAISettings {
  const value = (raw ?? {}) as Record<string, unknown>;

  if (Array.isArray(value.profiles)) {
    const profiles = value.profiles as AIProfile[];
    const activeId = typeof value.activeId === "string" ? value.activeId : "";
    const exists = profiles.some((profile) => profile.id === activeId);

    return {
      enabled: Boolean(value.enabled),
      activeId: exists ? activeId : (profiles[0]?.id ?? ""),
      profiles,
      contextLimit: numberOr(value.contextLimit, 80000),
      compactThreshold: numberOr(value.compactThreshold, 20000),
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
  };

  return {
    enabled: Boolean(legacy.enabled),
    activeId: hasLegacy ? profile.id : "",
    profiles: hasLegacy ? [profile] : [],
    contextLimit: 80000,
    compactThreshold: 20000,
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
