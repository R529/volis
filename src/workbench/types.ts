/** Board wall contracts. One view, one kind of item. */

/** A node drawn inside the card cover, in 0–100 cover coordinates. */
export type MiniNode = {
  x: number;
  y: number;
  w: number;
  h: number;
  /** "text" | "file" | "card" | "group" — decides how the chip is drawn. */
  kind: string;
  /** Theme colour name (orange, blue, …) or a raw hex the board stored. */
  tone: string;
  /** Readable excerpt. Empty means the chip stays a plain block. */
  text: string;
};

/** A connection drawn inside the card cover, in 0–100 cover coordinates. */
export type MiniEdge = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export interface BoardItem {
  /** Real .volis file in the vault. */
  file: import("obsidian").TFile;
  title: string;
  /** Nodes on the board (groups excluded from the cover drawing). */
  nodes: number;
  edges: number;
  updated: string;
  /** Sort key: the file's real modification time. */
  mtime: number;
  /** Sort key: the file's real creation time. */
  created: number;
  cover: {
    nodes: MiniNode[];
    edges: MiniEdge[];
  };
}
