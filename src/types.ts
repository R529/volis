export interface CardRef {
  file: string;
  blockId: string;
  linkpath: string;
}

export interface CardMeta {
  ref: CardRef;
  body: string;
  timePrefix: string;
  editable: string;
  date?: string;
  time?: string;
  tags: string[];
  stale: boolean;
}

export interface BlockRange {
  start: number;
  end: number;
}

export interface BlockContent {
  range: BlockRange;
  body: string;
  firstPrefix: string;
  contIndent: string;
  idLine: string;
}
