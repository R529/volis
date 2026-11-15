import { App, Debouncer, TFile, debounce } from "obsidian";

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
      const view: any = leaf.view;
      if (typeof view?.getViewData !== "function") continue;

      let raw = "";
      try {
        raw = view.getViewData() ?? "";
      } catch (error) {
        continue;
      }
      if (!raw) continue;

      if (raw.includes(file.basename) || raw.includes(file.path)) {
        this.pending.add((leaf as any).id ?? view.id ?? "");
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
        const view: any = leaf.view;
        const key = (leaf as any).id ?? view?.id ?? "";
        if (!this.pending.has(key)) continue;
        this.refreshView(view);
      }
      this.pending.clear();
    } finally {
      this.refreshing = false;
      this.onRefreshed();
    }
  }

  refreshView(view: any): void {
    if (!view || typeof view.getViewData !== "function" || typeof view.setViewData !== "function") {
      return;
    }

    const canvas = view?.canvas;
    const viewport = captureViewport(canvas);

    try {
      const json = view.getViewData();
      if (!json) return;

      // clear=true forces the view to drop its nodes and rebuild them, which is
      // the only reliable way to make embedded content re-read the source file.
      view.setViewData(json, true);

      restoreViewport(view.canvas, viewport);
    } catch (error) {
      console.error("[Volis] refresh failed", error);
    }
  }
}

function captureViewport(canvas: any): Viewport {
  const out: Viewport = {};
  ["tx", "ty", "tz", "zoom", "scale"].forEach((key) => {
    if (typeof canvas[key] === "number") out[key] = canvas[key];
  });
  return out;
}

function restoreViewport(canvas: any, viewport: Viewport): void {
  if (!canvas) return;
  Object.keys(viewport).forEach((key) => {
    try {
      canvas[key] = viewport[key];
    } catch (error) {
      // ignore
    }
  });
}
