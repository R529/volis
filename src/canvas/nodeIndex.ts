import { App } from "obsidian";
import { CardMeta } from "../types";
import { resolveCardRef } from "../parse/cardRef";
import { readCard } from "../store/cardStore";
import { CanvasNodeData, CanvasViewLike, collectNodes } from "./canvasTypes";

export { collectNodes } from "./canvasTypes";

export interface NodeEntry {
  nodeId: string;
  text: string;
  meta: CardMeta | null;
  loadedAt: number;
}

export class NodeIndex {
  private entries = new Map<string, NodeEntry>();
  private inFlight = new WeakSet<object>();
  private sourcePath = "";

  constructor(private app: App) {}

  clear(): void {
    this.entries.clear();
  }

  get(nodeId: string): NodeEntry | undefined {
    return this.entries.get(nodeId);
  }

  values(): NodeEntry[] {
    return Array.from(this.entries.values());
  }

  get size(): number {
    return this.entries.size;
  }

  async scan(canvasView: CanvasViewLike): Promise<void> {
    const canvas = canvasView?.canvas;
    if (!canvas?.nodes) return;
    if (this.inFlight.has(canvas)) return;

    this.inFlight.add(canvas);
    this.sourcePath = canvasView?.file?.path ?? "";

    try {
      const seen = new Set<string>();
      const pending: Promise<void>[] = [];

      for (const node of collectNodes(canvas.nodes)) {
        try {
          const data: CanvasNodeData | null =
            typeof node.getData === "function"
              ? (node.getData() ?? null)
              : (node as unknown as CanvasNodeData);
          if (!data || data.type !== "text") continue;

          const id = data.id;
          const text = typeof data.text === "string" ? data.text : "";
          if (!id) continue;
          seen.add(id);

          const existing = this.entries.get(id);
          const fresh =
            existing &&
            existing.text === text &&
            existing.loadedAt > 0 &&
            Date.now() - existing.loadedAt < 600;
          if (fresh) continue;

          const entry: NodeEntry =
            existing ?? { nodeId: id, text, meta: null, loadedAt: 0 };
          entry.text = text;
          this.entries.set(id, entry);
          pending.push(this.loadMeta(entry));
        } catch (error) {
          console.error("[Volis] node parse failed", error);
        }
      }

      for (const key of Array.from(this.entries.keys())) {
        if (!seen.has(key)) this.entries.delete(key);
      }

      await Promise.all(pending);
    } finally {
      this.inFlight.delete(canvas);
    }
  }

  private async loadMeta(entry: NodeEntry): Promise<void> {
    const ref = resolveCardRef(this.app, this.sourcePath, entry.text);
    if (!ref) {
      this.entries.delete(entry.nodeId);
      return;
    }
    try {
      entry.meta = await readCard(this.app, ref);
      entry.loadedAt = Date.now();
    } catch (error) {
      entry.meta = null;
    }
  }
}

