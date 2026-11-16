import { App, Modal, Setting } from "obsidian";

/** Small yes/no dialog used before destructive actions. */
export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly heading: string,
    private readonly message: string,
    private readonly confirmText: string,
    private readonly onConfirm: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h3", { text: this.heading });
    contentEl.createEl("p", { text: this.message, cls: "volis-confirm-text" });

    new Setting(contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText(this.confirmText)
          .setWarning()
          .onClick(() => {
            this.close();
            this.onConfirm();
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
