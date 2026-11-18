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

export type EdgeRelation =
  | "supports"
  | "refutes"
  | "causes"
  | "derives"
  | "source"
  | "sequence";

export interface BoardEdge {
  id: string;
  from: string;
  to: string;
  fromSide?: PortSide;
  toSide?: PortSide;
  /** Text shown on the line. Plain data: it stays in the board file, so the
   *  relation reads the same for the AI as it does on screen. */
  label?: string;
  /** Where that text sits on the line, as a parameter from 0 (start) to 1
   *  (end). A parameter, not a point: the label then keeps following the line
   *  when either card is dragged or resized. Missing means the middle. */
  labelAt?: number;
  color?: string;
  style?: "solid" | "dashed";
  arrow?: "target" | "both" | "none";
  /** Semantic role of the connection. Optional so older boards stay valid;
   *  outline and AI features can read it without parsing the label text. */
  relation?: EdgeRelation;
}

export interface BoardData {
  version: 1;
  nodes: BoardNode[];
  edges: BoardEdge[];
  viewport?: { tx: number; ty: number; scale: number };
}

export const DEFAULT_CARD_WIDTH = 280;
export const DEFAULT_FILE_WIDTH = 360;
