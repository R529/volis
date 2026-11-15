import { VolisAISettings } from "../settings";

export interface AIRequestOptions {
  maxTokens?: number;
  system?: string;
}

export interface AIProvider {
  readonly id: string;
  readonly configured: boolean;
  complete(prompt: string, options?: AIRequestOptions): Promise<string>;
}

export class NotConfiguredProvider implements AIProvider {
  readonly id = "none";
  readonly configured = false;

  async complete(): Promise<string> {
    throw new Error("AI 尚未配置");
  }
}

/**
 * Single place where a real provider is created.
 * Phase two only needs to return a different implementation here.
 */
export function createProvider(settings: VolisAISettings): AIProvider {
  if (!settings.enabled || !settings.baseUrl || !settings.model) {
    return new NotConfiguredProvider();
  }
  return new NotConfiguredProvider();
}
