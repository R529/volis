import { App, Modal } from "obsidian";
import { DoctorIssue, DoctorLevel } from "../board/doctor";

const GROUPS: Array<{ level: DoctorLevel; label: string; note: string }> = [
  { level: "error", label: "错误", note: "引用或结构已经不对" },
  { level: "warning", label: "提醒", note: "数据没坏，但会影响 AI 理解" },
  { level: "hint", label: "建议", note: "按需处理，通常可以忽略" },
];

export interface DoctorOffset {
  x: number;
  y: number;
}

/** Callbacks that let the report stay purely presentational. */
export interface DoctorActions {
  locate(issue: DoctorIssue): void;
  removeNode(nodeId: string): void;
  removeEdge(edgeId: string): void;
  addLabel(edgeId: string): void;
  rescan(): void;
  offset(): DoctorOffset;
  moved(offset: DoctorOffset): void;
}

/**
 * A read-only report. There is deliberately no "fix all" button: each row
 * carries only the actions that make sense for that specific finding, and
 * destructive ones open their own confirmation in the board view.
 *
 * The title bar is draggable so the report can be parked beside the board
 * while a finding is located — otherwise the modal covers what it points at.
 */
export class BoardDoctorModal extends Modal {
  private dragOffset: DoctorOffset;
  private dragStart: { x: number; y: number; ox: number; oy: number } | null = null;

  constructor(
    app: App,
    private readonly issues: DoctorIssue[],
    private readonly actions: DoctorActions
  ) {
    super(app);
    this.dragOffset = { ...actions.offset() };
  }

  onOpen(): void {
    this.modalEl.addClass("volis-doctor-modal");
    this.contentEl.addClass("volis-doctor-content");
    // Inline width wins over the theme's own modal sizing; the cap keeps a
    // narrow window from producing a horizontal scrollbar.

    this.titleEl.setText("白板体检");
    this.installDrag();
    this.applyOffset();
    this.render();
  }

  private applyOffset(): void {
    this.modalEl.style.transform = `translate(${this.dragOffset.x}px, ${this.dragOffset.y}px)`;
  }

  private installDrag(): void {
    const title = this.titleEl;
    title.addClass("volis-doctor-drag");
    title.setAttribute("title", "按住这里可以拖动窗口，让出白板");

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
      this.actions.moved({ ...this.dragOffset });
    };
    title.addEventListener("pointerup", finish);
    title.addEventListener("pointercancel", finish);
  }

  private render(): void {
    const host = this.contentEl;
    host.empty();

    host.createEl("p", {
      cls: "volis-doctor-summary",
      text:
        this.issues.length === 0
          ? "本次没有发现问题。拖动标题栏可以让出白板。"
          : `发现 ${this.issues.length} 项。只是报告，不会自动修改白板；拖动标题栏可以让出白板。`,
    });

    // Header and footer stay put; only the findings scroll. This keeps the
    // panel short even when a board produces dozens of rows.
    const scroll = host.createDiv({ cls: "volis-doctor-scroll" });

    if (this.issues.length === 0) {
      scroll.createDiv({ cls: "volis-doctor-empty", text: "没有问题，可以直接关闭。" });
    }

    for (const group of GROUPS) {
      const rows = this.issues.filter((issue) => issue.level === group.level);
      if (rows.length === 0) continue;

      const section = scroll.createDiv({ cls: "volis-doctor-group" });
      const head = section.createDiv({ cls: "volis-doctor-group-head" });
      head.createSpan({ text: group.label });
      head.createSpan({ cls: "volis-doctor-group-note", text: group.note });
      head.createSpan({ cls: "volis-doctor-count", text: `${rows.length}` });

      for (const issue of rows) {
        const row = section.createDiv({ cls: "volis-doctor-row" });
        row.createDiv({ cls: `volis-doctor-dot is-${issue.level}` });

        const body = row.createDiv({ cls: "volis-doctor-body" });
        body.createDiv({ cls: "volis-doctor-title", text: issue.title });
        body.createDiv({ cls: "volis-doctor-detail", text: issue.detail });

        const actions = row.createDiv({ cls: "volis-doctor-actions" });

        if (issue.nodeIds.length > 0 || issue.edgeId) {
          const locate = actions.createEl("button", {
            cls: "volis-doctor-btn",
            text: "定位",
          });
          locate.addEventListener("click", () => this.actions.locate(issue));
        }

        if (issue.removableNodeId) {
          const nodeId = issue.removableNodeId;
          const remove = actions.createEl("button", {
            cls: "volis-doctor-btn is-danger",
            text: "移除节点",
          });
          remove.addEventListener("click", () => this.actions.removeNode(nodeId));
        }

        if (issue.kind === "dangling-edge" && issue.edgeId) {
          const edgeId = issue.edgeId;
          const remove = actions.createEl("button", {
            cls: "volis-doctor-btn is-danger",
            text: "删除连线",
          });
          remove.addEventListener("click", () => this.actions.removeEdge(edgeId));
        }

        if (issue.kind === "unlabeled-edge" && issue.edgeId) {
          const edgeId = issue.edgeId;
          const label = actions.createEl("button", {
            cls: "volis-doctor-btn",
            text: "添加标签",
          });
          label.addEventListener("click", () => this.actions.addLabel(edgeId));
        }
      }
    }

    // One footer row: the note on the left, rescan on the right. Closing is
    // already available as the modal's own X in the title bar.
    const footer = host.createDiv({ cls: "volis-doctor-footer" });
    footer.createSpan({
      cls: "volis-doctor-foot",
      text: "所有修复都需要逐条确认，可 Ctrl+Z 撤销。",
    });
    const rescan = footer.createEl("button", { cls: "volis-doctor-btn", text: "重新扫描" });
    rescan.addEventListener("click", () => this.actions.rescan());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
