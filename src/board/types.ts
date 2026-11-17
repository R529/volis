export interface BaseNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height?: number;
  /** Colour name only, never a raw value, so themes and the visual style can
   *  change without touching stored data. */
  color?: string;
}

export interface CardNode extends BaseNode {
  type: "card";
  file: string;
  blockId: string;
}

export interface TextNode extends BaseNode {
  type: "text";
  text: string;
  /** A sticky is an unfinished text node: yellow until it is finalised. */
  sticky?: boolean;
}

export interface FileNode extends BaseNode {
  type: "file";
  file: string;
}

export interface GroupNode extends BaseNode {
  type: "group";
  label?: string;
}

export type BoardNode = CardNode | TextNode | FileNode | GroupNode;

export type PortSide = "top" | "right" | "bottom" | "left";

export interface BoardEdge {
  id: string;
  from: string;
  to: string;
  fromSide?: PortSide;
  toSide?: PortSide;
  label?: string;
  color?: string;
  style?: "solid" | "dashed";
  arrow?: "target" | "both" | "none";
}

export interface BoardData {
  version: 1;
  nodes: BoardNode[];
  edges: BoardEdge[];
  viewport?: { tx: number; ty: number; scale: number };
}

export const DEFAULT_CARD_WIDTH = 280;
export const DEFAULT_FILE_WIDTH = 360;
