import { App, Modal, Setting } from "obsidian";

/** Minimal rename dialog, styled like Obsidian's own prompt. */
export class RenameModal extends Modal {
  constructor(
    app: App,
    private initial: string,
    private onSubmit: (value: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "重命名白板" });

    const input = contentEl.createEl("input", { type: "text" });
    input.value = this.initial;
    input.addClass("volis-rename-input");
    input.focus();
    input.select();

    const submit = () => {
      const value = input.value.trim();
      if (!value) return;
      this.close();
      this.onSubmit(value);
    };

    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        submit();
      }
      if (evt.key === "Escape") {
        evt.preventDefault();
        this.close();
      }
    });

    new Setting(contentEl).addButton((button) =>
      button.setButtonText("重命名").setCta().onClick(submit)
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
