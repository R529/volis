import { App, Debouncer, TFile, WorkspaceLeaf, debounce } from "obsidian";
import { CanvasLike, CanvasViewLike } from "./canvasTypes";

interface Viewport {
  [key: string]: number;
}

export class SyncEngine {
  private pending = new Set<string>();
  private scheduled: Debouncer<[], void>;
  private refreshing = false;

  constructor(
    private app: App,
    private onRefreshed: () => void,
    private canRefresh: () => boolean = () => true
  ) {
    this.scheduled = debounce(() => this.flush(), 400, true);
  }

  flushPending(): void {
    if (this.pending.size > 0) this.scheduled();
  }

  handleModify(file: TFile): void {
    if (file.extension !== "md") return;

    const leaves = this.app.workspace.getLeavesOfType("canvas");
    for (const leaf of leaves) {
      const view = leaf.view as unknown as CanvasViewLike;
      if (typeof view.getViewData !== "function") continue;

      let raw = "";
      try {
        raw = view.getViewData() ?? "";
      } catch (error) {
        continue;
      }
      if (!raw) continue;

      if (raw.includes(file.basename) || raw.includes(file.path)) {
        this.pending.add(leafKey(leaf, view));
      }
    }

    if (this.pending.size > 0) this.scheduled();
  }

  private flush(): void {
    if (this.refreshing) return;
    // Never rebuild the canvas while the user is typing in it.
    if (!this.canRefresh()) return;

    this.refreshing = true;
    try {
      const leaves = this.app.workspace.getLeavesOfType("canvas");
      for (const leaf of leaves) {
        const view = leaf.view as unknown as CanvasViewLike;
        const key = leafKey(leaf, view);
        if (!this.pending.has(key)) continue;
        this.refreshView(view);
      }
      this.pending.clear();
    } finally {
      this.refreshing = false;
      this.onRefreshed();
    }
  }

  refreshView(view: CanvasViewLike): void {
    if (typeof view.getViewData !== "function" || typeof view.setViewData !== "function") {
      return;
    }

    const canvas = view.canvas;
    const viewport = captureViewport(canvas);

    try {
      const json = view.getViewData();
      if (!json) return;

      // clear=true forces the view to drop its nodes and rebuild them, which is
      // the only reliable way to make embedded content re-read the source file.
      void view.setViewData(json, true);

      restoreViewport(view.canvas, viewport);
    } catch (error) {
      console.error("[Volis] refresh failed", error);
    }
  }
}

function leafKey(leaf: WorkspaceLeaf, view: CanvasViewLike): string {
  return (leaf as unknown as { id?: string }).id ?? view.id ?? "";
}

function captureViewport(canvas: CanvasLike | undefined): Viewport {
  const out: Viewport = {};
  if (!canvas) return out;
  const values = canvas as unknown as Record<string, unknown>;
  for (const key of ["tx", "ty", "tz", "zoom", "scale"]) {
    const value = values[key];
    if (typeof value === "number") out[key] = value;
  }
  return out;
}

function restoreViewport(canvas: CanvasLike | undefined, viewport: Viewport): void {
  if (!canvas) return;
  const values = canvas as unknown as Record<string, number>;
  for (const key of Object.keys(viewport)) {
    try {
      values[key] = viewport[key];
    } catch (error) {
      // ignore
    }
  }
}
