import { requestUrl } from "obsidian";
import type { AICapability, AIProfile } from "../settings";
import { sanitizeBaseUrl } from "./url";

interface CapabilityPreset {
  /** Matched against the model id, case insensitive. */
  match: RegExp;
  label: string;
  contextWindow: number;
  maxOutput: number;
}

/**
 * Declarative on purpose: adding a new vendor is one line here, not a code
 * change somewhere else. Values are deliberately conservative — being wrong
 * low only costs a bit of headroom, being wrong high costs a failed request.
 * The UI always shows the source and lets the user override or probe.
 */
export const CAPABILITY_PRESETS: CapabilityPreset[] = [
  { match: /claude|sonnet|opus|haiku/i, label: "Anthropic Claude", contextWindow: 200000, maxOutput: 32000 },
  { match: /gemini/i, label: "Google Gemini", contextWindow: 1000000, maxOutput: 32768 },
  { match: /gpt-5|gpt-4\.1|gpt-4o|o3|o4-mini/i, label: "OpenAI", contextWindow: 400000, maxOutput: 32768 },
  { match: /deepseek/i, label: "DeepSeek", contextWindow: 1000000, maxOutput: 32768 },
  { match: /kimi|moonshot/i, label: "Moonshot Kimi", contextWindow: 1000000, maxOutput: 32768 },
  { match: /glm|zhipu|chatglm|智谱/i, label: "智谱 GLM", contextWindow: 1000000, maxOutput: 32768 },
  { match: /qwen|qwq|tongyi|通义/i, label: "通义千问", contextWindow: 1000000, maxOutput: 32768 },
  { match: /doubao|skylark|seed-oss/i, label: "豆包", contextWindow: 256000, maxOutput: 16384 },
  { match: /ernie|wenxin|文心/i, label: "文心一言", contextWindow: 128000, maxOutput: 8192 },
  { match: /minimax|abab/i, label: "MiniMax", contextWindow: 245000, maxOutput: 16384 },
  { match: /llama|mistral|ollama|lmstudio|local/i, label: "本地模型", contextWindow: 32768, maxOutput: 8192 },
];

/** Used when nothing matches: safe for almost every hosted model. */
export const FALLBACK_CAPABILITY: AICapability = {
  contextWindow: 128000,
  maxOutput: 8192,
  source: "fallback",
};

/** Best guess from the model id alone. Never pretends to be measured. */
export function inferCapability(model: string): AICapability {
  const hit = CAPABILITY_PRESETS.find((preset) => preset.match.test(model ?? ""));
  if (!hit) return { ...FALLBACK_CAPABILITY };
  return {
    contextWindow: hit.contextWindow,
    maxOutput: hit.maxOutput,
    source: "preset",
  };
}

export function presetLabel(model: string): string {
  return CAPABILITY_PRESETS.find((preset) => preset.match.test(model ?? ""))?.label ?? "未识别模型";
}

/** Guards against half-written or absurd capability values in data.json. */
export function isCapabilitySane(value: unknown): value is AICapability {
  const cap = value as AICapability | undefined;
  if (!cap || typeof cap !== "object") return false;
  const { contextWindow, maxOutput } = cap;
  if (!isSaneNumber(contextWindow, 1000, 10000000)) return false;
  if (!isSaneNumber(maxOutput, 64, 1000000)) return false;
  return maxOutput < contextWindow;
}

function isSaneNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "?";
  if (value >= 1000000) {
    const millions = value / 1000000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (value >= 1000) {
    const thousands = value / 1000;
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
  }
  return String(Math.round(value));
}

export function describeCapability(capability: AICapability | undefined): string {
  if (!capability) return "未设置";
  return `${formatTokens(capability.contextWindow)} 窗口 · ${formatTokens(capability.maxOutput)} 输出`;
}

export function capabilitySourceLabel(source: AICapability["source"]): string {
  if (source === "probe") return "接口探测";
  if (source === "manual") return "手动设置";
  if (source === "preset") return "预设推断";
  return "保守默认";
}

export interface ProbeResult {
  capability: AICapability | null;
  notes: string[];
}

/**
 * Tries to read the real limits from the provider. Anything it cannot confirm
 * is reported as a note instead of being guessed, so the caller can keep the
 * preset value and say so.
 */
export async function probeCapability(profile: AIProfile): Promise<ProbeResult> {
  const notes: string[] = [];

  if (profile.protocol === "openai") {
    const fromList = await probeOpenAI(profile, notes);
    if (fromList) return { capability: fromList, notes };
    notes.push("接口没有返回窗口信息，保留预设值；可手动填写校正。");
    return { capability: null, notes };
  }

  const fromError = await probeAnthropic(profile, notes);
  if (fromError) return { capability: fromError, notes };

  notes.push(
    "Anthropic 协议没有模型列表接口，这个网关也没有报出上限，保留预设值；可手动填写校正。"
  );
  return { capability: null, notes };
}

async function probeOpenAI(profile: AIProfile, notes: string[]): Promise<AICapability | null> {
  const url = `${sanitizeBaseUrl(profile.baseUrl)}/models`;
  let body: string;
  try {
    const response = await requestUrl({
      url,
      method: "GET",
      headers: { Authorization: `Bearer ${profile.apiKey}` },
      throw: false,
    });
    if (response.status >= 400) {
      notes.push(`模型列表接口返回 ${response.status}，改用手动值。`);
      return null;
    }
    body = response.text;
  } catch (error) {
    notes.push("模型列表接口连不上，改用手动值。");
    return null;
  }

  let parsed: { data?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(body) as { data?: Array<Record<string, unknown>> };
  } catch {
    notes.push("模型列表不是合法 JSON，改用手动值。");
    return null;
  }

  const entries = parsed.data ?? [];
  const modelId = (entry: Record<string, unknown>): string =>
    typeof entry.id === "string" ? entry.id : "";

  const target =
    entries.find((entry) => modelId(entry) === profile.model) ??
    entries.find((entry) => modelId(entry).includes(profile.model));

  if (!target) {
    notes.push("模型列表里没有这个模型，改用手动值。");
    return null;
  }

  const provider = (target.top_provider ?? {}) as Record<string, unknown>;
  const contextWindow = firstNumber([
    target.context_length,
    target.context_window,
    target.max_context_length,
    target.max_model_len,
    provider.context_length,
  ]);
  const maxOutput = firstNumber([
    target.max_output_tokens,
    target.max_completion_tokens,
    provider.max_completion_tokens,
  ]);

  if (!contextWindow) {
    notes.push("模型列表没有给窗口大小，改用手动值。");
    return null;
  }

  return {
    contextWindow: Math.round(contextWindow),
    maxOutput: Math.round(maxOutput ?? Math.min(8192, contextWindow / 4)),
    source: "probe",
  };
}

async function probeAnthropic(profile: AIProfile, notes: string[]): Promise<AICapability | null> {
  const base = sanitizeBaseUrl(profile.baseUrl);
  const url = base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;

  try {
    const response = await requestUrl({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": profile.apiKey,
        "anthropic-version": "2023-06-01",
      },
      // An impossible cap: a strict gateway answers with the real maximum.
      body: JSON.stringify({
        model: profile.model,
        max_tokens: 4000000,
        messages: [{ role: "user", content: "ping" }],
      }),
      throw: false,
    });

    if (response.status < 400) {
      notes.push("网关没有校验 max_tokens 上限，无法通过报错探到真实值。");
      return null;
    }

    const text = response.text ?? "";
    const hit = text.match(/(\d{3,7})\s*(?:tokens?|个\s*token)?[^0-9]{0,20}(?:maximum|max|上限)/i) ??
      text.match(/(?:maximum|max|上限)[^0-9]{0,24}(\d{3,7})/i);

    if (hit) {
      const value = Number(hit[1]);
      if (Number.isFinite(value) && value >= 256 && value <= 1000000) {
        // Only the output cap is confirmed; the window keeps its previous value.
        const contextWindow = profile.capability?.contextWindow ?? 0;
        if (!isCapabilitySane({ contextWindow, maxOutput: value, source: "probe" })) {
          notes.push("只探到输出上限，缺少窗口大小，请手动补全。");
          return null;
        }
        return { contextWindow, maxOutput: value, source: "probe" };
      }
    }

    notes.push("报错里没有可解析的上限数字，保留预设值。");
    return null;
  } catch (error) {
    notes.push("探测请求失败，保留预设值。");
    return null;
  }
}

function firstNumber(values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}
