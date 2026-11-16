import { requestUrl } from "obsidian";
import { AIProfile } from "../settings";
import { describeNetworkError, sanitizeBaseUrl } from "./url";

export interface AIMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AIRequestOptions {
  maxTokens?: number;
  system?: string;
}

export interface AIProvider {
  readonly id: string;
  readonly configured: boolean;
  complete(messages: AIMessage[], options?: AIRequestOptions): Promise<string>;
}

export class NotConfiguredProvider implements AIProvider {
  readonly id = "none";
  readonly configured = false;

  async complete(): Promise<string> {
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
  error?: { message?: string };
};

/** Reads the reply out of the many shapes OpenAI-compatible APIs return. */
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

  // Reasoning models sometimes only fill this field.
  const reasoning = choice.message?.reasoning_content;
  if (typeof reasoning === "string" && reasoning.trim()) return reasoning.trim();

  if (typeof choice.text === "string" && choice.text.trim()) return choice.text.trim();

  return "";
}

function describeHttpError(status: number, body: string): string {
  let detail = "";
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    detail = parsed?.error?.message ?? "";
  } catch {
    detail = body.slice(0, 160);
  }

  if (status === 401 || status === 403) return "API Key 无效或没有权限";
  if (status === 404) return "接口地址或模型名不正确";
  if (status === 429) return "请求过于频繁或额度不足";
  return detail || `请求失败（HTTP ${status}）`;
}

class OpenAICompatibleProvider implements AIProvider {
  readonly id = "openai";
  readonly configured = true;

  constructor(private readonly settings: AIProfile) {}

  async complete(history: AIMessage[], options: AIRequestOptions = {}): Promise<string> {
    const messages: Array<{ role: string; content: string }> = [];
    if (options.system) messages.push({ role: "system", content: options.system });
    messages.push(...history);

    const url = `${sanitizeBaseUrl(this.settings.baseUrl)}/chat/completions`;

    let response;
    try {
      response = await requestUrl({
        url,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.settings.apiKey}`,
        },
        body: JSON.stringify({
          model: this.settings.model,
          messages,
          max_tokens: options.maxTokens ?? 2048,
          temperature: 0.6,
        }),
        throw: false,
      });
    } catch (error) {
      throw new Error(describeNetworkError(error, url));
    }

    if (response.status >= 400) {
      throw new Error(describeHttpError(response.status, response.text));
    }

    let data: ChatResponse | null = null;
    try {
      data = JSON.parse(response.text) as ChatResponse;
    } catch {
      data = null;
    }

    if (data?.error?.message) {
      throw new Error(data.error.message);
    }

    const text = extractReply(data);
    if (text) return text;

    const reason = data?.choices?.[0]?.finish_reason;
    const summary = (response.text ?? "").replace(/\s+/g, " ").slice(0, 300);

    throw new Error(
      `模型没有返回内容${reason ? `（finish_reason: ${reason}）` : ""}。\n响应：${summary || "（空）"}`
    );
  }
}

class AnthropicProvider implements AIProvider {
  readonly id = "anthropic";
  readonly configured = true;

  constructor(private readonly settings: AIProfile) {}

  async complete(history: AIMessage[], options: AIRequestOptions = {}): Promise<string> {
    const base = sanitizeBaseUrl(this.settings.baseUrl);
    const url = base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;

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
        body: JSON.stringify({
          model: this.settings.model,
          max_tokens: options.maxTokens ?? 2048,
          system: options.system,
          messages: history,
        }),
        throw: false,
      });
    } catch (error) {
      throw new Error(describeNetworkError(error, url));
    }

    if (response.status >= 400) {
      throw new Error(describeHttpError(response.status, response.text));
    }

    const data = response.json as { content?: Array<{ type: string; text?: string }> };
    const text = (data?.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("")
      .trim();

    if (!text) throw new Error("模型没有返回内容");
    return text;
  }
}

/** Single place where a provider is created from the active profile. */
export function createProvider(profile: AIProfile | null): AIProvider {
  if (!profile || !profile.baseUrl.trim() || !profile.model.trim()) {
    return new NotConfiguredProvider();
  }

  if (profile.protocol === "anthropic") {
    return new AnthropicProvider(profile);
  }

  return new OpenAICompatibleProvider(profile);
}
