import { App, Modal, Setting, Notice } from "obsidian";
import { AIProfile } from "../settings";
import { sanitizeBaseUrl } from "../ai/url";

const PRESETS: Record<string, { name: string; protocol: "openai" | "anthropic"; baseUrl: string; model: string }> = {
  deepseek: { name: "DeepSeek", protocol: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  kimi: { name: "Kimi", protocol: "openai", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  zhipu: { name: "智谱 GLM", protocol: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  openai: { name: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  anthropic: { name: "Anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-20250514" },
  ollama: { name: "本地 Ollama", protocol: "openai", baseUrl: "http://localhost:11434/v1", model: "qwen2.5" },
};

export class AIProfileModal extends Modal {
  private draft: AIProfile;

  constructor(
    app: App,
    profile: AIProfile | null,
    private readonly onSubmit: (profile: AIProfile) => void
  ) {
    super(app);

    this.draft = profile
      ? { ...profile }
      : {
          id: `p${Date.now()}`,
          name: "",
          protocol: "openai",
          baseUrl: "",
          model: "",
          apiKey: "",
        };
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("volis-ai-modal");
    contentEl.createEl("h3", { text: this.draft.name ? "编辑模型配置" : "添加模型配置" });

    new Setting(contentEl)
      .setName("快速填入")
      .setDesc("选一个服务自动填好地址和模型，Key 仍需自己填。")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "选择服务…");
        for (const [key, preset] of Object.entries(PRESETS)) {
          dropdown.addOption(key, preset.name);
        }

        dropdown.onChange((value) => {
          const preset = PRESETS[value];
          if (!preset) return;

          this.draft.name = preset.name;
          this.draft.protocol = preset.protocol;
          this.draft.baseUrl = preset.baseUrl;
          this.draft.model = preset.model;

          this.refreshFields();
          dropdown.setValue("");
        });
      });

    this.fieldsEl = contentEl.createDiv();

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("取消").onClick(() => this.close())
      )
      .addButton((button) =>
        button
          .setButtonText("保存")
          .setCta()
          .onClick(() => this.submit())
      );

    this.renderFields();
  }

  private fieldsEl: HTMLElement | null = null;
  private nameInput: HTMLInputElement | null = null;
  private urlInput: HTMLInputElement | null = null;
  private modelInput: HTMLInputElement | null = null;
  private keyInput: HTMLInputElement | null = null;
  private protocolValue: "openai" | "anthropic" = "openai";

  private renderFields(): void {
    const host = this.fieldsEl;
    if (!host) return;

    host.empty();
    this.protocolValue = this.draft.protocol;

    new Setting(host).setName("名称").addText((text) => {
      this.nameInput = text.inputEl;
      text
        .setPlaceholder("例如 DeepSeek")
        .setValue(this.draft.name)
        .onChange((value) => {
          this.draft.name = value.trim();
        });
    });

    new Setting(host).setName("接口协议").addDropdown((dropdown) =>
      dropdown
        .addOption("openai", "OpenAI 兼容")
        .addOption("anthropic", "Anthropic Messages")
        .setValue(this.draft.protocol)
        .onChange((value) => {
          this.protocolValue = value === "anthropic" ? "anthropic" : "openai";
          this.draft.protocol = this.protocolValue;
        })
    );

    new Setting(host)
      .setName("接口地址")
      .setDesc("例如 https://api.deepseek.com/v1")
      .addText((text) => {
        this.urlInput = text.inputEl;
        text
          .setPlaceholder("https://")
          .setValue(this.draft.baseUrl)
          .onChange((value) => {
            this.draft.baseUrl = value.trim();
          });
      });

    new Setting(host).setName("模型").addText((text) => {
      this.modelInput = text.inputEl;
      text
        .setPlaceholder("deepseek-chat")
        .setValue(this.draft.model)
        .onChange((value) => {
          this.draft.model = value.trim();
        });
    });

    new Setting(host)
      .setName("API Key")
      .setDesc("仅保存在本机插件配置中。")
      .addText((text) => {
        this.keyInput = text.inputEl;
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-…")
          .setValue(this.draft.apiKey)
          .onChange((value) => {
            this.draft.apiKey = value.trim();
          });
      });
  }

  /** Keeps the visible inputs in sync when a preset fills the draft. */
  private refreshFields(): void {
    this.draft.baseUrl = sanitizeBaseUrl(this.draft.baseUrl);
    this.renderFields();
  }

  private submit(): void {
    const baseUrl = sanitizeBaseUrl(this.draft.baseUrl);

    if (!this.draft.name.trim()) {
      new Notice("请填写名称");
      return;
    }
    if (!baseUrl) {
      new Notice("请填写接口地址");
      return;
    }
    if (!this.draft.model.trim()) {
      new Notice("请填写模型名");
      return;
    }

    this.onSubmit({
      ...this.draft,
      name: this.draft.name.trim(),
      baseUrl,
      model: this.draft.model.trim(),
      apiKey: this.draft.apiKey.trim(),
    });

    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
