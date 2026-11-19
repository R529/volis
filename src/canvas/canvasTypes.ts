import type { App, TAbstractFile } from "obsidian";

/**
 * Minimal structural types for Obsidian Canvas internals. Canvas is not part
 * of the public Obsidian API, so these describe only the fields Volis reads.
 * Keeping them here avoids scattering `any` across the whole plugin.
 */

export interface CanvasNodeData {
  id?: string;
  type?: string;
  text?: string;
  [key: string]: unknown;
}

export interface CanvasNodeLike {
  id?: string;
  nodeEl?: HTMLElement | null;
  getData?: () => CanvasNodeData | null;
  remove?: () => void;
}

export type CanvasNodeCollection =
  | Map<string, CanvasNodeLike>
  | Set<CanvasNodeLike>
  | CanvasNodeLike[]
  | Record<string, CanvasNodeLike>;

export interface CanvasLike {
  nodes?: CanvasNodeCollection;
  selection?: Set<CanvasNodeLike> | CanvasNodeLike[];
  get?: (id: string) => CanvasNodeLike | null;
  removeNode?: (node: CanvasNodeLike) => void;
}

export interface CanvasViewLike {
  app?: App;
  file?: TAbstractFile | null;
  containerEl: HTMLElement;
  canvas?: CanvasLike;
  getViewType(): string;
  getViewData?(): string;
  setViewData?(data: string, clear?: boolean): void | Promise<void>;
  openAIPanel?(): void;
  openBoardDoctor?(): void;
  openBoardOutline?(): void;
  openOutlinePanel?(): void;
  openExportModal?(): void;
  openNodeSearch?(): void;
  openInsertPanelAtCenter?(kind?: string): void;
  openExportMarkdown?(): void;
  id?: string;
}

/** Canvas node collections appear in several shapes; one place handles all. */
export function collectNodes(
  nodes: CanvasNodeCollection | null | undefined
): CanvasNodeLike[] {
  if (!nodes) return [];
  if (Array.isArray(nodes)) return nodes.slice();
  if (nodes instanceof Map) return Array.from(nodes.values());
  if (nodes instanceof Set) return Array.from(nodes);
  return Object.values(nodes);
}
