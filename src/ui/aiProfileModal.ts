import { App, Modal, Setting, Notice } from "obsidian";
import { AIProfile, AIThinkingMode } from "../settings";
import { sanitizeBaseUrl } from "../ai/url";
import {
  capabilitySourceLabel,
  describeCapability,
  inferCapability,
  probeCapability,
} from "../ai/capability";

const PRESETS: Record<
  string,
  { name: string; protocol: "openai" | "anthropic"; baseUrl: string; model: string }
> = {
  deepseek: { name: "DeepSeek", protocol: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  kimi: { name: "Kimi", protocol: "openai", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  zhipu: { name: "智谱 GLM", protocol: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  qwen: { name: "通义千问", protocol: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  openai: { name: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  anthropic: { name: "Anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-20250514" },
  ollama: { name: "本地 Ollama", protocol: "openai", baseUrl: "http://localhost:11434/v1", model: "qwen2.5" },
};

export class AIProfileModal extends Modal {
  private draft: AIProfile;
  private probing = false;

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
          capability: inferCapability(""),
          thinking: "auto",
          cache: true,
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
          this.draft.capability = inferCapability(preset.model);

          this.refreshFields();
          dropdown.setValue("");
        });
      });

    this.fieldsEl = contentEl.createDiv();

    new Setting(contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("保存").setCta().onClick(() => this.submit()));

    this.renderFields();
  }

  private fieldsEl: HTMLElement | null = null;

  private renderFields(): void {
    const host = this.fieldsEl;
    if (!host) return;

    host.empty();

    new Setting(host).setName("名称").addText((text) => {
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
          this.draft.protocol = value === "anthropic" ? "anthropic" : "openai";
        })
    );

    new Setting(host)
      .setName("接口地址")
      .setDesc("例如 https://api.deepseek.com/v1")
      .addText((text) => {
        text
          .setPlaceholder("https://")
          .setValue(this.draft.baseUrl)
          .onChange((value) => {
            this.draft.baseUrl = value.trim();
          });
      });

    new Setting(host)
      .setName("模型")
      .setDesc("改动模型名后，能力值会按名字重新推断；也可点下面的「探测」。")
      .addText((text) => {
        text
          .setPlaceholder("deepseek-chat")
          .setValue(this.draft.model)
          .onChange((value) => {
            this.draft.model = value.trim();
            if (this.draft.capability?.source !== "manual") {
              this.draft.capability = inferCapability(this.draft.model);
            }
          });
      });

    new Setting(host)
      .setName("API Key")
      .setDesc("仅保存在本机插件配置中。")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-…")
          .setValue(this.draft.apiKey)
          .onChange((value) => {
            this.draft.apiKey = value.trim();
          });
      });

    host.createEl("h4", { text: "模型能力" });
    host.createDiv({
      cls: "volis-ai-hint",
      text:
        "这两项填的是「这个模型能吃多少」，不是插件的限制。留空表示按模型名自动推断；" +
        "填错了只会让插件少用或多用一点余量，不会损坏数据。",
    });

    const capability = this.draft.capability ?? inferCapability(this.draft.model);

    new Setting(host)
      .setName("上下文窗口（token）")
      .setDesc(`当前：${describeCapability(capability)} · ${capabilitySourceLabel(capability.source)}`)
      .addText((text) => {
        text.inputEl.type = "number";
        text
          .setPlaceholder(String(capability.contextWindow))
          .setValue(String(capability.contextWindow))
          .onChange((value) => {
            // Empty means "go back to the inferred value", as the hint says.
            if (!value.trim()) {
              this.draft.capability = inferCapability(this.draft.model);
              return;
            }
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed < 1000) return;
            this.draft.capability = {
              contextWindow: Math.round(parsed),
              maxOutput: this.draft.capability?.maxOutput ?? 8192,
              source: "manual",
            };
          });
      });

    new Setting(host)
      .setName("单次输出上限（token）")
      .setDesc(
        "模型一次最多能写多少。思考过程也花这份额度，所以带思考的模型建议 16384 以上。"
      )
      .addText((text) => {
        text.inputEl.type = "number";
        text
          .setPlaceholder(String(capability.maxOutput))
          .setValue(String(capability.maxOutput))
          .onChange((value) => {
            if (!value.trim()) {
              const inferred = inferCapability(this.draft.model);
              this.draft.capability = {
                contextWindow: this.draft.capability?.contextWindow ?? inferred.contextWindow,
                maxOutput: inferred.maxOutput,
                source: inferred.source,
              };
              return;
            }
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed < 64) return;
            this.draft.capability = {
              contextWindow: this.draft.capability?.contextWindow ?? 128000,
              maxOutput: Math.round(parsed),
              source: "manual",
            };
          });
      });

    new Setting(host)
      .setName("探测真实上限")
      .setDesc("向接口问一次，能读到就写进来；读不到会说明原因，不会瞎猜。")
      .addButton((button) =>
        button.setButtonText(this.probing ? "探测中…" : "探测").onClick(async () => {
          if (this.probing) return;
          if (!this.draft.baseUrl.trim() || !this.draft.model.trim() || !this.draft.apiKey.trim()) {
            new Notice("先填好地址、模型和 Key 再探测");
            return;
          }

          this.probing = true;
          this.renderFields();
          try {
            const result = await probeCapability({
              ...this.draft,
              capability: this.draft.capability ?? inferCapability(this.draft.model),
            });
            if (result.capability) {
              this.draft.capability = result.capability;
              new Notice(`已探测：${describeCapability(result.capability)}`);
            } else {
              new Notice(result.notes[0] ?? "没有探测到，保留当前值");
            }
          } catch (error) {
            new Notice(`探测失败：${error instanceof Error ? error.message : String(error)}`);
          } finally {
            this.probing = false;
            this.renderFields();
          }
        })
      );

    host.createEl("h4", { text: "调用偏好" });

    new Setting(host)
      .setName("思考模式")
      .setDesc(
        "自动：不发送思考参数，沿用模型默认行为。开启：显式请求推理，会消耗输出额度。" +
          "关闭：跳过推理，正文更多、响应更快，分析深度可能下降。"
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("auto", "自动（沿用模型默认）")
          .addOption("on", "开启（显式启用推理）")
          .addOption("off", "关闭（跳过推理）")
          .setValue(this.draft.thinking ?? "auto")
          .onChange((value) => {
            this.draft.thinking = value as AIThinkingMode;
          })
      );

    new Setting(host)
      .setName("缓存前缀")
      .setDesc(
        "仅 Anthropic 协议生效：给白板内容打缓存标记，连续追问时输入费大幅下降（实测可省 99%）。" +
          "网关不支持时会自动去掉重试。"
      )
      .addToggle((toggle) =>
        toggle.setValue(this.draft.cache !== false).onChange((value) => {
          this.draft.cache = value;
        })
      );
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

    const capability = this.draft.capability ?? inferCapability(this.draft.model.trim());

    this.onSubmit({
      ...this.draft,
      name: this.draft.name.trim(),
      baseUrl,
      model: this.draft.model.trim(),
      apiKey: this.draft.apiKey.trim(),
      capability:
        capability.maxOutput >= capability.contextWindow
          ? { ...capability, maxOutput: Math.floor(capability.contextWindow / 4) }
          : capability,
      thinking: this.draft.thinking ?? "auto",
      cache: this.draft.cache !== false,
    });

    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
