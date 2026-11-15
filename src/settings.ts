export type AIProtocol = "anthropic" | "openai";

export interface VolisAISettings {
  enabled: boolean;
  protocol: AIProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface VolisSettings {
  showBadge: boolean;
  badgeFormat: "date" | "full";
  boardFolder: string;
  cardFolder: string;
  ai: VolisAISettings;
}

export const DEFAULT_SETTINGS: VolisSettings = {
  showBadge: true,
  badgeFormat: "date",
  boardFolder: "",
  cardFolder: "",
  ai: {
    enabled: false,
    protocol: "anthropic",
    baseUrl: "",
    model: "",
    apiKey: "",
  },
};
