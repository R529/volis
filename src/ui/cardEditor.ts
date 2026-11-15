import { App, Modal, Notice } from "obsidian";
import { CardMeta } from "../types";

export class CardEditorModal extends Modal {
  private value: string;

  constructor(
    app: App,
    private meta: CardMeta,
    private onSave: (value: string) => Promise<boolean>
  ) {
    super(app);
    this.value = meta.body;
  }

  onOpen(): void {
    const { contentEl, titleEl, modalEl } = this;
    modalEl.addClass("volis-editor-modal");
    titleEl.setText("编辑卡片");

    const metaEl = contentEl.createDiv({ cls: "volis-editor-meta" });
    metaEl.setText(this.describe());

    const textarea = contentEl.createEl("textarea", { cls: "volis-editor-input" });
    textarea.value = this.value;
    textarea.addEventListener("input", () => {
      this.value = textarea.value;
    });
    textarea.addEventListener("keydown", (evt: KeyboardEvent) => {
      if ((evt.ctrlKey || evt.metaKey) && evt.key === "Enter") {
        evt.preventDefault();
        void this.submit();
      }
    });

    window.setTimeout(() => {
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    }, 40);

    const footer = contentEl.createDiv({ cls: "volis-editor-footer" });
    const cancel = footer.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());

    const save = footer.createEl("button", { text: "保存", cls: "mod-cta" });
    save.addEventListener("click", () => {
      void this.submit();
    });
  }

  private describe(): string {
    const parts: string[] = [];
    if (this.meta.tags.length > 0) parts.push(this.meta.tags.map((t) => `#${t}`).join(" "));
    if (this.meta.date) parts.push(this.meta.date);
    if (this.meta.time) parts.push(this.meta.time);
    parts.push(this.meta.ref.file.replace(/\.md$/, ""));
    return parts.join(" · ");
  }

  private async submit(): Promise<void> {
    if (this.value === this.meta.body) {
      this.close();
      return;
    }
    const ok = await this.onSave(this.value);
    if (!ok) {
      new Notice("保存失败：卡片可能已移动或删除");
      return;
    }
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
