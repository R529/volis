import { App, PluginSettingTab, Setting } from "obsidian";
import type VolisPlugin from "./main";

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

    new Setting(containerEl)
      .setName("启用 AI")
      .setDesc("当前版本仅保留接口，尚未实现调用。开启后设置项才会生效。")
      .addToggle((toggle) =>
        toggle.setValue(ai.enabled).onChange(async (value) => {
          ai.enabled = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("接口协议")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("anthropic", "Anthropic Messages")
          .addOption("openai", "OpenAI 兼容")
          .setValue(ai.protocol)
          .onChange(async (value) => {
            ai.protocol = value === "openai" ? "openai" : "anthropic";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("例如 https://api.example.com，不要带路径后缀。")
      .addText((text) =>
        text
          .setPlaceholder("https://api.example.com")
          .setValue(ai.baseUrl)
          .onChange(async (value) => {
            ai.baseUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("模型")
      .addText((text) =>
        text
          .setPlaceholder("model-name")
          .setValue(ai.model)
          .onChange(async (value) => {
            ai.model = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("仅保存在本机插件配置中。")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(ai.apiKey)
          .onChange(async (value) => {
            ai.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

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
