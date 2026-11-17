import { requestUrl } from "obsidian";
import type { AIProfile, AIThinkingMode } from "../settings";
import { describeNetworkError, sanitizeBaseUrl } from "./url";

export interface AIMessage {
  role: "user" | "assistant";
  content: string;
}

/** A system prompt section. `cache` asks the provider to memoise the prefix. */
export interface AISystemBlock {
  text: string;
  cache?: boolean;
}

export interface AIRequestOptions {
  maxTokens?: number;
  system?: string | AISystemBlock[];
  /** "auto" leaves it to the vendor, "off" asks for no reasoning pass. */
  thinking?: AIThinkingMode;
  /** Explicit cache marker (Anthropic). Ignored by OpenAI-compatible calls. */
  cache?: boolean;
}

export interface AIUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface AIResult {
  text: string;
  /** True when the provider stopped at the token cap rather than finishing. */
  truncated: boolean;
  stopReason?: string;
  usage?: AIUsage;
  /** How many request variants were needed (1 = first try worked). */
  attempts: number;
}

export interface AIProvider {
  readonly id: string;
  readonly configured: boolean;
  complete(messages: AIMessage[], options?: AIRequestOptions): Promise<AIResult>;
}

/** Fallback output cap when a profile has no capability recorded. */
export const DEFAULT_MAX_TOKENS = 8192;

const THINKING_ATE_BUDGET =
  "模型的思考过程用完了这次输出额度，没留下正文。可以在设置里把这个模型的「单次输出上限」调大，" +
  "或把「思考模式」设为关闭后重试。";

/** Lets the caller retry with a bigger cap instead of showing an error. */
export function isThinkingBudgetError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("模型的思考过程用完了");
}

export class NotConfiguredProvider implements AIProvider {
  readonly id = "none";
  readonly configured = false;

  async complete(): Promise<AIResult> {
    throw new Error("AI 尚未配置，请先在设置里填写接口地址和模型");
  }
}

type ChatResponse = {
  choices?: Array<{
    finish_reason?: string;
    text?: string;
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null;
      reasoning_content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string };
};

function extractReply(data: ChatResponse | null): string {
  const choice = data?.choices?.[0];
  if (!choice) return "";

  const content = choice.message?.content;
  if (typeof content === "string" && content.trim()) return content.trim();

  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
      .join("")
      .trim();
    if (joined) return joined;
  }

  const reasoning = choice.message?.reasoning_content;
  if (typeof reasoning === "string" && reasoning.trim()) return reasoning.trim();
  if (typeof choice.text === "string" && choice.text.trim()) return choice.text.trim();
  return "";
}

function describeHttpError(status: number, body: string): string {
  let detail = "";
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
    detail = parsed?.error?.message ?? parsed?.message ?? "";
  } catch {
    detail = body.slice(0, 160);
  }

  if (status === 401 || status === 403) return "API Key 无效或没有权限";
  if (status === 404) return "接口地址或模型名不正确";
  if (status === 413) return "内容太长，超出模型能接受的请求大小";
  if (status === 429) return "请求过于频繁或额度不足";
  return detail || `请求失败（HTTP ${status}）`;
}

function isTruncatedStop(reason: string | undefined | null): boolean {
  return reason === "length" || reason === "max_tokens" || reason === "max_output_tokens";
}

/**
 * A model may reject a cap larger than it supports. Ask high, then step down
 * instead of pinning every model to the smallest common value.
 */
function tokenLadder(preferred: number): number[] {
  const steps: number[] = [];
  for (const value of [preferred, 32768, 16384, 8192, 4096, 2048]) {
    const rounded = Math.round(value);
    if (rounded <= 0) continue;
    if (steps.length === 0 || rounded < steps[steps.length - 1]) steps.push(rounded);
  }
  return steps;
}

/**
 * Retrying blindly wastes calls when a gateway rejects a model outright. This
 * separates "the cap was too big" from "a parameter is not supported", so the
 * loop can jump to the right variant instead of walking the whole ladder.
 */
function classifyRetry(status: number, body: string): "cap" | "param" | null {
  if (status !== 400 && status !== 422) return null;
  if (/max_?tokens|max_?output|output_tokens|最大输出|输出上限/i.test(body)) return "cap";
  if (
    /thinking|cache_control|reasoning|enable_thinking|unknown.*(field|parameter)|unsupported|not support|invalid.*(parameter|request body|argument)|参数|格式/i.test(
      body
    )
  ) {
    return "param";
  }
  return null;
}

/**
 * The first attempts keep the preferred cap and peel features off one by one;
 * the rest step the cap down. A cap error jumps straight past the feature
 * chain, a parameter error walks through it first.
 */
function advanceAttempt(index: number, reason: "cap" | "param", capStart: number): number {
  if (reason === "cap") return index < capStart ? capStart : index + 1;
  return index + 1;
}

/**
 * Joins a continuation to the text it continues. Models usually repeat a few
 * characters at the seam; drop that overlap so the sentence reads as one.
 */
export function mergeContinuation(base: string, chunk: string): string {
  const head = chunk.replace(/^\s+/, "");
  if (!head) return base;
  if (!base) return head;

  const next = stripRepeatedHeading(base, head);
  const tail = base.slice(-400);
  const limit = Math.min(tail.length, next.length, 200);

  for (let size = limit; size >= 2; size -= 1) {
    if (tail.slice(-size) === next.slice(0, size)) {
      return base + next.slice(size);
    }
  }

  const glue = /[\u3400-\u9fff，。；：、）]$/.test(base) && /^[A-Za-z0-9]/.test(next) ? " " : "";
  return base + glue + next;
}

/** A continuation often re-emits the heading it stopped under. Drop it. */
function stripRepeatedHeading(base: string, chunk: string): string {
  const firstBreak = chunk.indexOf("\n");
  if (firstBreak <= 0) return chunk;
  const firstLine = chunk.slice(0, firstBreak).trim();
  if (!/^#{1,6}\s|^\*\*|^---/.test(firstLine)) return chunk;

  const baseLines = base.split("\n");
  for (let i = baseLines.length - 1; i >= 0 && i >= baseLines.length - 6; i -= 1) {
    if (baseLines[i].trim() !== firstLine) continue;
    const rest = chunk.slice(firstBreak + 1).replace(/^\n+/, "").trimEnd();
    return rest ? `\n\n${rest}` : "";
  }
  return chunk;
}

/**
 * Closes quotes and emphasis left open by a truncated answer. Applied once at
 * the very end, so nothing is double-closed by a later chunk.
 */
export function balanceTail(text: string): string {
  const pairs: Array<[string, string]> = [
    ["「", "」"],
    ["“", "”"],
    ["（", "）"],
    ["【", "】"],
    ["(", ")"],
    ["[", "]"],
  ];

  let result = text;
  for (const [open, close] of pairs) {
    if (count(result, open) > count(result, close)) result += close;
  }

  // An odd number of ** means one was opened and never closed. Removing the
  // dangling marker beats appending one, which would bold everything after it.
  if (count(result, "**") % 2 === 1) {
    const last = result.lastIndexOf("**");
    if (last >= 0) result = result.slice(0, last) + result.slice(last + 2);
  }
  return result;
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

interface Attempt {
  maxTokens: number;
  cache: boolean;
  thinking: AIThinkingMode | undefined;
}

interface AttemptPlan {
  attempts: Attempt[];
  /** Index where the cap ladder starts, i.e. where features are all off. */
  capStart: number;
}

function buildAttempts(options: AIRequestOptions, fallbackCap: number): AttemptPlan {
  const preferred = Math.round(options.maxTokens ?? fallbackCap);
  const useCache = options.cache !== false;
  const thinking = options.thinking && options.thinking !== "auto" ? options.thinking : undefined;
  const attempts: Attempt[] = [];

  // Feature chain: full → no cache → no cache and no thinking.
  attempts.push({ maxTokens: preferred, cache: useCache, thinking });
  if (useCache) attempts.push({ maxTokens: preferred, cache: false, thinking });
  if (thinking) attempts.push({ maxTokens: preferred, cache: false, thinking: undefined });

  const capStart = attempts.length;

  // Cap ladder: simplest variant only, so a strict gateway is not asked twice.
  for (const maxTokens of tokenLadder(preferred)) {
    if (maxTokens >= preferred) continue;
    attempts.push({ maxTokens, cache: false, thinking: undefined });
  }

  return { attempts, capStart };
}

function systemBlocks(options: AIRequestOptions): AISystemBlock[] {
  if (!options.system) return [];
  if (typeof options.system === "string") return [{ text: options.system }];
  return options.system.filter((block) => Boolean(block?.text));
}

/**
 * Anthropic accepts a list of system blocks; only blocks flagged `cache` get
 * the marker, so the stable board section is memoised and the rest is not.
 */
function anthropicSystem(options: AIRequestOptions, cache: boolean): Array<Record<string, unknown>> {
  const blocks = systemBlocks(options);
  if (blocks.length === 0) return [];

  const cacheable = cache && blocks.some((block) => block.cache);
  return blocks.map((block) => {
    const body: Record<string, unknown> = { type: "text", text: block.text };
    if (cacheable && block.cache) body.cache_control = { type: "ephemeral" };
    return body;
  });
}

function openAISystem(options: AIRequestOptions): string {
  return systemBlocks(options)
    .map((block) => block.text)
    .join("\n\n");
}

class OpenAICompatibleProvider implements AIProvider {
  readonly id = "openai";
  readonly configured = true;

  constructor(private readonly settings: AIProfile) {}

  async complete(history: AIMessage[], options: AIRequestOptions = {}): Promise<AIResult> {
    const url = `${sanitizeBaseUrl(this.settings.baseUrl)}/chat/completions`;
    const fallbackCap = this.settings.capability?.maxOutput ?? DEFAULT_MAX_TOKENS;
    const plan = buildAttempts(options, fallbackCap);
    const system = openAISystem(options);

    const build = (attempt: Attempt): string => {
      const messages: Array<{ role: string; content: string }> = [];
      if (system) messages.push({ role: "system", content: system });
      messages.push(...history);

      const body: Record<string, unknown> = {
        model: this.settings.model,
        messages,
        max_tokens: attempt.maxTokens,
        temperature: 0.6,
      };
      if (attempt.thinking === "off") body.enable_thinking = false;
      if (attempt.thinking === "on") body.enable_thinking = true;
      return JSON.stringify(body);
    };

    let lastStatus = 0;
    let lastBody = "";
    let index = 0;
    let calls = 0;

    while (index < plan.attempts.length) {
      const attempt = plan.attempts[index];
      calls += 1;
      let response;
      try {
        response = await requestUrl({
          url,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.settings.apiKey}`,
          },
          body: build(attempt),
          throw: false,
        });
      } catch (error) {
        throw new Error(describeNetworkError(error, url));
      }

      if (response.status < 400) return parseOpenAI(response.text, response.json, calls);

      lastStatus = response.status;
      lastBody = response.text ?? "";
      const reason = classifyRetry(response.status, lastBody);
      if (!reason) break;
      index = advanceAttempt(index, reason, plan.capStart);
    }

    if (lastStatus === 0) throw new Error("请求没有返回结果");
    throw new Error(describeHttpError(lastStatus, lastBody));
  }
}

function parseOpenAI(text: string, json: unknown, attempts: number): AIResult {
  let data = (json as ChatResponse | undefined) ?? null;
  if (!data) {
    try {
      data = JSON.parse(text) as ChatResponse;
    } catch {
      data = null;
    }
  }

  if (data?.error?.message) throw new Error(data.error.message);

  const reason = data?.choices?.[0]?.finish_reason;
  const reply = extractReply(data);
  const usage: AIUsage = {
    inputTokens: data?.usage?.prompt_tokens,
    outputTokens: data?.usage?.completion_tokens,
    cachedTokens: data?.usage?.prompt_tokens_details?.cached_tokens,
    reasoningTokens: data?.usage?.completion_tokens_details?.reasoning_tokens,
  };

  if (reply) {
    return { text: reply, truncated: isTruncatedStop(reason), stopReason: reason, usage, attempts };
  }
  if (isTruncatedStop(reason)) throw new Error(THINKING_ATE_BUDGET);

  const summary = (text ?? "").replace(/\s+/g, " ").slice(0, 300);
  throw new Error(
    `模型没有返回内容${reason ? `（finish_reason: ${reason}）` : ""}。\n响应：${summary || "（空）"}`
  );
}

class AnthropicProvider implements AIProvider {
  readonly id = "anthropic";
  readonly configured = true;

  constructor(private readonly settings: AIProfile) {}

  async complete(history: AIMessage[], options: AIRequestOptions = {}): Promise<AIResult> {
    const base = sanitizeBaseUrl(this.settings.baseUrl);
    const url = base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
    const fallbackCap = this.settings.capability?.maxOutput ?? DEFAULT_MAX_TOKENS;
    const plan = buildAttempts(options, fallbackCap);

    const build = (attempt: Attempt): string => {
      const body: Record<string, unknown> = {
        model: this.settings.model,
        max_tokens: attempt.maxTokens,
        messages: history,
      };

      const system = anthropicSystem(options, attempt.cache);
      if (system.length > 0) body.system = system;

      if (attempt.thinking === "off") {
        body.thinking = { type: "disabled" };
      } else if (attempt.thinking === "on") {
        body.thinking = {
          type: "enabled",
          budget_tokens: Math.max(1024, Math.min(8192, Math.floor(attempt.maxTokens / 2))),
        };
      }

      return JSON.stringify(body);
    };

    let lastStatus = 0;
    let lastBody = "";
    let index = 0;
    let calls = 0;

    while (index < plan.attempts.length) {
      const attempt = plan.attempts[index];
      calls += 1;
      let response;
      try {
        response = await requestUrl({
          url,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.settings.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: build(attempt),
          throw: false,
        });
      } catch (error) {
        throw new Error(describeNetworkError(error, url));
      }

      if (response.status < 400) return parseAnthropic(response.json, calls);

      lastStatus = response.status;
      lastBody = response.text ?? "";
      const reason = classifyRetry(response.status, lastBody);
      if (!reason) break;
      index = advanceAttempt(index, reason, plan.capStart);
    }

    if (lastStatus === 0) throw new Error("请求没有返回结果");
    throw new Error(describeHttpError(lastStatus, lastBody));
  }
}

function parseAnthropic(json: unknown, attempts: number): AIResult {
  const data = json as
    | {
        content?: Array<{ type: string; text?: string }>;
        stop_reason?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      }
    | undefined;

  const parts = data?.content ?? [];
  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("")
    .trim();

  const usage: AIUsage = {
    inputTokens: data?.usage?.input_tokens,
    outputTokens: data?.usage?.output_tokens,
    cachedTokens: data?.usage?.cache_read_input_tokens,
    cacheWriteTokens: data?.usage?.cache_creation_input_tokens,
  };

  if (!text) {
    const usedThinking = parts.some((part) => part.type === "thinking");
    if (usedThinking || isTruncatedStop(data?.stop_reason)) throw new Error(THINKING_ATE_BUDGET);
    throw new Error("模型没有返回内容");
  }

  return {
    text,
    truncated: isTruncatedStop(data?.stop_reason),
    stopReason: data?.stop_reason,
    usage,
    attempts,
  };
}

/** Single place where a provider is created from the active profile. */
export function createProvider(profile: AIProfile | null): AIProvider {
  if (!profile || !profile.baseUrl.trim() || !profile.model.trim()) {
    return new NotConfiguredProvider();
  }
  if (profile.protocol === "anthropic") return new AnthropicProvider(profile);
  return new OpenAICompatibleProvider(profile);
}
