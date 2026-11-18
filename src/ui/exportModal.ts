import { App, Modal, Notice } from "obsidian";
import type { ExportFormat } from "../board/markdownExport";

export interface MarkdownExportOptions {
  boardTitle: string;
  nodeCount: number;
  build: (format: ExportFormat) => string;
  save: (markdown: string) => Promise<string>;
}

/**
 * Preview first, write second: exporting is the one place where the board is
 * turned into a document, so the user should see the result before it lands in
 * the vault. The preview is a plain textarea, not a rendered view, because what
 * gets copied is the Markdown source.
 */
export class MarkdownExportModal extends Modal {
  private format: ExportFormat = "headings";
  private previewEl: HTMLTextAreaElement | null = null;
  private tabs: HTMLButtonElement[] = [];
  private markdown = "";
  private dragOffset = { x: 0, y: 0 };
  private dragStart: { x: number; y: number; ox: number; oy: number } | null = null;

  constructor(
    app: App,
    private readonly options: MarkdownExportOptions
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("volis-export-modal");
    this.contentEl.addClass("volis-export-content");
    this.modalEl.style.width = "680px";
    this.modalEl.style.maxWidth = "94vw";
    this.modalEl.style.maxHeight = "84vh";

    this.titleEl.setText("导出 Markdown");
    // The board behind the preview is often the thing being checked, so the
    // window has to be movable out of the way.
    this.installDrag();

    this.contentEl.createDiv({
      cls: "volis-export-sub",
      text: `白板「${this.options.boardTitle}」· ${this.options.nodeCount} 个节点。推导与因果生成层级，支持、反驳、来源保留为注解。`,
    });

    const tabs = this.contentEl.createDiv({ cls: "volis-export-tabs" });
    const makeTab = (format: ExportFormat, label: string): void => {
      const button = tabs.createEl("button", { cls: "volis-export-tab", text: label });
      button.dataset.format = format;
      button.addEventListener("click", () => {
        this.format = format;
        this.refresh();
      });
      this.tabs.push(button);
    };
    makeTab("headings", "标题层级");
    makeTab("list", "嵌套列表");

    this.previewEl = this.contentEl.createEl("textarea", { cls: "volis-export-preview" });
    this.previewEl.readOnly = true;
    this.previewEl.spellcheck = false;

    const footer = this.contentEl.createDiv({ cls: "volis-export-footer" });
    footer.createDiv({
      cls: "volis-export-foot",
      text: "保存会在白板所在目录生成同名笔记，重名自动加序号。",
    });

    const actions = footer.createDiv({ cls: "volis-export-actions" });

    const copyBtn = actions.createEl("button", { cls: "volis-export-btn", text: "复制" });
    copyBtn.addEventListener("click", () => void this.copy());

    const saveBtn = actions.createEl("button", {
      cls: "mod-cta volis-export-btn",
      text: "保存为笔记",
    });
    saveBtn.addEventListener("click", () => void this.save());

    this.refresh();
  }

  private applyOffset(): void {
    this.modalEl.style.transform = `translate(${this.dragOffset.x}px, ${this.dragOffset.y}px)`;
  }

  private installDrag(): void {
    const title = this.titleEl;
    title.addClass("volis-export-drag");
    title.setAttribute("title", "按住这里可以拖动窗口");

    title.addEventListener("pointerdown", (evt) => {
      if (evt.button !== 0) return;
      evt.preventDefault();
      this.dragStart = {
        x: evt.clientX,
        y: evt.clientY,
        ox: this.dragOffset.x,
        oy: this.dragOffset.y,
      };
      title.setPointerCapture(evt.pointerId);
    });

    title.addEventListener("pointermove", (evt) => {
      if (!this.dragStart) return;
      this.dragOffset = {
        x: this.dragStart.ox + evt.clientX - this.dragStart.x,
        y: this.dragStart.oy + evt.clientY - this.dragStart.y,
      };
      this.applyOffset();
    });

    const finish = (evt: PointerEvent): void => {
      if (!this.dragStart) return;
      this.dragStart = null;
      if (title.hasPointerCapture(evt.pointerId)) {
        title.releasePointerCapture(evt.pointerId);
      }
    };
    title.addEventListener("pointerup", finish);
    title.addEventListener("pointercancel", finish);
  }

  private refresh(): void {
    for (const tab of this.tabs) {
      tab.toggleClass("is-active", tab.dataset.format === this.format);
    }
    this.markdown = this.options.build(this.format);
    if (this.previewEl) this.previewEl.value = this.markdown;
  }

  private async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.markdown);
      new Notice("已复制 Markdown");
    } catch (error) {
      new Notice("复制失败，请在预览框中手动选中复制");
    }
  }

  private async save(): Promise<void> {
    try {
      const path = await this.options.save(this.markdown);
      new Notice(`已保存为笔记：${path}`);
      this.close();
    } catch (error) {
      console.error("[Volis] export note failed", error);
      new Notice("保存失败，请检查白板所在目录的写入权限");
    }
  }

  onClose(): void {
    this.contentEl.empty();
    this.previewEl = null;
    this.tabs = [];
  }
}
