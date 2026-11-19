import { App, PluginSettingTab, Setting, setIcon } from "obsidian";
import type VolisPlugin from "./main";
import { AIProfile, AIThinkingMode, DEFAULT_CONTEXT_POLICY } from "./settings";
import { AIProfileModal } from "./ui/aiProfileModal";
import {
  capabilitySourceLabel,
  describeCapability,
  formatTokens,
  inferCapability,
} from "./ai/capability";

function voidAsync(fn: () => Promise<void>): () => void {
  return () => { void fn(); };
}

export class VolisSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: VolisPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("volis-settings");

    new Setting(containerEl).setName("常规").setHeading();

    this.divider(containerEl);
    new Setting(containerEl).setName("角标").setHeading();

    new Setting(containerEl)
      .setName("显示角标")
      .setDesc("在卡片节点右下角显示日期。仅在画布视图中生效，不影响卡片正文。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showBadge).onChange(async (value) => {
          this.plugin.settings.showBadge = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("角标内容")
      .setDesc("精简只显示日期；完整显示标签、日期和时间。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("date", "精简（11-11）")
          .addOption("full", "完整（#标签 11-11 11:08）")
          .setValue(this.plugin.settings.badgeFormat)
          .onChange(async (value) => {
            this.plugin.settings.badgeFormat = value === "full" ? "full" : "date";
            await this.plugin.saveSettings();
          })
      );

    this.divider(containerEl);
    new Setting(containerEl).setName("白板").setHeading();

    new Setting(containerEl)
      .setName("白板保存位置")
      .setDesc("新建白板时把文件存到这个文件夹；留空表示库根目录。每次新建都会生成一个独立文件。")
      .addText((text) =>
        text
          .setPlaceholder("留空 = 库根目录")
          .setValue(this.plugin.settings.boardFolder)
          .onChange(async (value) => {
            this.plugin.settings.boardFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("卡片笔记目录")
      .setDesc("从白板转成卡片时写到这里。留空则自动读 Collis 的设置，读不到用 00-Inbox/速记。")
      .addText((text) =>
        text
          .setPlaceholder("留空 = 跟随 Collis")
          .setValue(this.plugin.settings.cardFolder)
          .onChange(async (value) => {
            this.plugin.settings.cardFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    this.divider(containerEl);
    this.renderAI(containerEl);
    this.divider(containerEl);
    this.renderDiagnostics(containerEl);
  }

  /** A thin rule between sections; keeps the long settings page scannable. */
  private divider(host: HTMLElement): void {
    host.createDiv({ cls: "volis-settings-divider" });
  }

  private renderAI(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("AI").setHeading();

    const ai = this.plugin.settings.ai;
    const save = () => this.plugin.saveSettings();

    new Setting(containerEl)
      .setName("启用 AI")
      .setDesc("开启后可在白板中选中节点提问，内容发送至当前启用的模型。")
      .addToggle((toggle) =>
        toggle.setValue(ai.enabled).onChange(async (value) => {
          ai.enabled = value;
          await save();
        })
      );

    containerEl.createDiv({
      cls: "volis-ai-hint",
      text:
        "发送量由模型自己的窗口决定，插件不额外设限；实际用量见 AI 面板顶部。" +
        "批量处理上百条卡片时建议选 200K 以上窗口的模型。",
    });

    new Setting(containerEl)
      .setName("默认思考模式")
      .setDesc(
        "新建配置未单独指定时采用。开启：模型先推理再作答，占用输出额度，分析更深。" +
          "关闭：跳过推理，正文更多、响应更快。自动：沿用模型厂商的默认行为。"
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("auto", "自动（沿用模型默认）")
          .addOption("on", "开启（显式启用推理）")
          .addOption("off", "关闭（跳过推理）")
          .setValue(ai.thinking)
          .onChange(async (value) => {
            ai.thinking = value as AIThinkingMode;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("内容装不下时")
      .setDesc("超出模型窗口时的处理方式。两种方式都不会静默少发。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("auto", "自动压缩（面板标注调整内容）")
          .addOption("ask", "先询问我")
          .setValue(ai.onOverflow)
          .onChange(async (value) => {
            ai.onOverflow = value === "ask" ? "ask" : "auto";
            await save();
          })
      );

    new Setting(containerEl)
      .setName("最多续写段数")
      .setDesc("回答被输出上限截断时自动续写的段数；0 表示不续写。")
      .addSlider((slider) =>
        slider
          .setLimits(0, 6, 1)
          .setValue(ai.continuations)
          .setDynamicTooltip()
          .onChange(async (value) => {
            ai.continuations = value;
            await save();
          })
      );

    this.renderAdvanced(containerEl, save);
    this.renderCards(containerEl, save);
  }

  /** Every density knob lives here so tuning later needs no code change. */
  private renderAdvanced(containerEl: HTMLElement, save: () => Promise<void>): void {
    const ai = this.plugin.settings.ai;
    const details = containerEl.createEl("details", { cls: "volis-ai-advanced" });
    details.createEl("summary", { text: "高级 · 内容分配规则" });

    new Setting(details)
      .setName("笔记每篇保底（字符）")
      .setDesc("长笔记被压缩时至少保留这么多字，避免只剩开头一句。")
      .addText((text) => {
        text.inputEl.type = "number";
        text
          .setPlaceholder(String(DEFAULT_CONTEXT_POLICY.noteFloorChars))
          .setValue(String(ai.policy.noteFloorChars))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed < 0) return;
            ai.policy.noteFloorChars = Math.round(parsed);
            await save();
          });
      });

    new Setting(details)
      .setName("笔记单篇上限（字符）")
      .setDesc("单篇最多发送多少字，防止一篇长文吃掉整个预算。")
      .addText((text) => {
        text.inputEl.type = "number";
        text
          .setPlaceholder(String(DEFAULT_CONTEXT_POLICY.noteCapChars))
          .setValue(String(ai.policy.noteCapChars))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed < 200) return;
            ai.policy.noteCapChars = Math.round(parsed);
            await save();
          });
      });

    new Setting(details)
      .setName("普通节点压缩阶梯（字符）")
      .setDesc("预算不够时按这个顺序逐级压缩，逗号分隔，从宽到窄。")
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_CONTEXT_POLICY.ladder.join(", "))
          .setValue(ai.policy.ladder.join(", "))
          .onChange(async (value) => {
            const ladder = value
              .split(/[,，\s]+/)
              .map((part) => Number(part))
              .filter((part) => Number.isFinite(part) && part >= 0);
            if (ladder.length === 0) return;
            ai.policy.ladder = ladder.sort((a, b) => b - a);
            await save();
          });
      });

    new Setting(details)
      .setName("预算安全余量（token）")
      .setDesc("每次请求预留这么多，吸收估算误差和 system 提示。")
      .addText((text) => {
        text.inputEl.type = "number";
        text
          .setPlaceholder(String(DEFAULT_CONTEXT_POLICY.safetyTokens))
          .setValue(String(ai.policy.safetyTokens))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed < 0) return;
            ai.policy.safetyTokens = Math.round(parsed);
            await save();
          });
      });
  }

  private renderCards(containerEl: HTMLElement, save: () => Promise<void>): void {
    const ai = this.plugin.settings.ai;
    const listEl = containerEl.createDiv({ cls: "volis-ai-cards" });

    const renderCards = () => {
      listEl.empty();

      if (ai.profiles.length === 0) {
        listEl.createDiv({
          cls: "volis-ai-empty",
          text: "还没有模型配置。点下面的「添加配置」新建一个。",
        });
        return;
      }

      for (const profile of ai.profiles) {
        const active = profile.id === ai.activeId;
        const card = listEl.createDiv({ cls: "volis-ai-card" });
        if (active) card.addClass("is-active");

        card.createDiv({
          cls: "volis-ai-avatar",
          text: (profile.name || "?").trim().charAt(0).toUpperCase(),
        });

        const main = card.createDiv({ cls: "volis-ai-card-main" });
        main.createDiv({ cls: "volis-ai-card-name", text: profile.name || "未命名配置" });

        const capability = profile.capability ?? inferCapability(profile.model);
        main.createDiv({
          cls: "volis-ai-card-meta",
          text: `${describeCapability(capability)} · ${capabilitySourceLabel(capability.source)} · ${profile.protocol === "anthropic" ? "Anthropic" : "OpenAI 兼容"}`,
        });
        main.createDiv({
          cls: "volis-ai-card-url",
          text: profile.baseUrl || "未填写接口地址",
        });

        const actions = card.createDiv({ cls: "volis-ai-card-actions" });

        if (!active) {
          const useBtn = actions.createEl("button", { cls: "volis-ai-use", text: "启用" });
          useBtn.addEventListener("click", voidAsync(async () => {
            ai.activeId = profile.id;
            ai.enabled = true;
            await save();
            renderCards();
          }));
        }

        const editBtn = actions.createEl("button", {
          cls: "volis-ai-icon",
          attr: { "aria-label": "编辑" },
        });
        setIcon(editBtn, "pencil");
        editBtn.addEventListener("click", () => {
          new AIProfileModal(this.app, profile, (next: AIProfile) => { void (async () => {
            const index = ai.profiles.findIndex((item) => item.id === profile.id);
            if (index === -1) return;

            ai.profiles[index] = next;
            await save();
            renderCards();
          })();
        }).open();
        });

        const delBtn = actions.createEl("button", {
          cls: "volis-ai-icon is-danger",
          attr: { "aria-label": "删除" },
        });
        setIcon(delBtn, "trash-2");
        delBtn.addEventListener("click", voidAsync(async () => {
          ai.profiles = ai.profiles.filter((item) => item.id !== profile.id);
          if (ai.activeId === profile.id) {
            ai.activeId = ai.profiles[0]?.id ?? "";
          }
          await save();
          renderCards();
        }));
      }
    };

    renderCards();

    new Setting(containerEl)
      .setName("添加配置")
      .setDesc("每个配置可以填自己的窗口和输出上限，互不影响。")
      .addButton((button) =>
        button
          .setButtonText("添加配置")
          .setCta()
          .onClick(() => {
            new AIProfileModal(this.app, null, (profile: AIProfile) => { void (async () => {
              ai.profiles.push(profile);
              if (!ai.activeId) ai.activeId = profile.id;
              await save();
              renderCards();
            })();
          }).open();
          })
      );
  }

  private renderDiagnostics(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("诊断").setHeading();

    const stat = containerEl.createEl("p", {
      text: "在画布视图中打开本页，可看到当前识别到的卡片数量。",
    });

    new Setting(containerEl).setName("当前画布").addButton((button) =>
      button.setButtonText("刷新识别").onClick(() => {
        this.plugin.scheduleRefresh(0);
        window.setTimeout(() => {
          stat.setText(`当前画布识别到 ${this.plugin.recognizedCount()} 张卡片。`);
        }, 300);
      })
    );

    const active = this.plugin.settings.ai.profiles.find(
      (profile) => profile.id === this.plugin.settings.ai.activeId
    );
    const capability = active?.capability ?? inferCapability(active?.model ?? "");
    new Setting(containerEl)
      .setName("当前模型可用输入")
      .setDesc(
        `窗口 ${formatTokens(capability.contextWindow)} − 输出 ${formatTokens(capability.maxOutput)} − 余量 ${formatTokens(
          this.plugin.settings.ai.policy.safetyTokens
        )}`
      );
  }
}
