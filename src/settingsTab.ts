import { App, PluginSettingTab, Setting, setIcon } from "obsidian";
import type VolisPlugin from "./main";
import { AIProfile } from "./settings";
import { AIProfileModal } from "./ui/aiProfileModal";

export class VolisSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: VolisPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Volis" });

    containerEl.createEl("h3", { text: "角标" });

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

    containerEl.createEl("h3", { text: "白板" });

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

    containerEl.createEl("h3", { text: "AI" });

    const ai = this.plugin.settings.ai;
    const save = () => this.plugin.saveSettings();

    new Setting(containerEl)
      .setName("启用 AI")
      .setDesc("开启后，白板内可以选中节点让 AI 分析。内容会发送到当前使用的配置。")
      .addToggle((toggle) =>
        toggle.setValue(ai.enabled).onChange(async (value) => {
          ai.enabled = value;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("单次发送上限（字符）")
      .setDesc(
        "默认 80000，约 5 万 token。超出会按级精简：先截短每个节点，再减少节点数。" +
          "固定使用 1M 窗口模型（DeepSeek V4、GLM-5.3、Kimi K3 等）可调到 300000；200K 窗口的模型建议保持 80000 以内。"
      )
      .addText((text) => {
        text.inputEl.type = "number";
        text
          .setPlaceholder("80000")
          .setValue(String(ai.contextLimit))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed < 20000 || parsed > 500000) return;
            ai.contextLimit = Math.round(parsed);
            ai.compactThreshold = Math.round(ai.contextLimit / 4);
            await save();
          });
      });

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
        main.createDiv({
          cls: "volis-ai-card-url",
          text: profile.baseUrl || "（未填写地址）",
        });

        const actions = card.createDiv({ cls: "volis-ai-card-actions" });

        if (!active) {
          const useBtn = actions.createEl("button", { cls: "volis-ai-use", text: "启用" });
          useBtn.addEventListener("click", async () => {
            ai.activeId = profile.id;
            ai.enabled = true;
            await save();
            renderCards();
          });
        }

        const editBtn = actions.createEl("button", {
          cls: "volis-ai-icon",
          attr: { "aria-label": "编辑" },
        });
        setIcon(editBtn, "pencil");
        editBtn.addEventListener("click", () => {
          new AIProfileModal(this.app, profile, async (next: AIProfile) => {
            const index = ai.profiles.findIndex((item) => item.id === profile.id);
            if (index === -1) return;

            ai.profiles[index] = next;
            await save();
            renderCards();
          }).open();
        });

        const delBtn = actions.createEl("button", {
          cls: "volis-ai-icon is-danger",
          attr: { "aria-label": "删除" },
        });
        setIcon(delBtn, "trash-2");
        delBtn.addEventListener("click", async () => {
          ai.profiles = ai.profiles.filter((item) => item.id !== profile.id);
          if (ai.activeId === profile.id) {
            ai.activeId = ai.profiles[0]?.id ?? "";
          }
          await save();
          renderCards();
        });
      }
    };

    renderCards();

    new Setting(containerEl)
      .setName("添加配置")
      .setDesc("在弹窗里填写名称、地址和模型，保存后会出现在上面。")
      .addButton((button) =>
        button
          .setButtonText("添加配置")
          .setCta()
          .onClick(() => {
            new AIProfileModal(this.app, null, async (profile: AIProfile) => {
              ai.profiles.push(profile);
              if (!ai.activeId) ai.activeId = profile.id;
              await save();
              renderCards();
            }).open();
          })
      );

    containerEl.createEl("h3", { text: "诊断" });

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
  }
}
