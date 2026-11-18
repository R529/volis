import type { EdgeRelation } from "./types";

/** Visual language for a semantic connection. The relation is stored on the
 *  edge; colour, dash and arrow are defaults that the user can still override
 *  from the edge bar. */
export interface EdgeRelationMeta {
  id: EdgeRelation;
  label: string;
  color: string;
  style: "solid" | "dashed";
  arrow: "target" | "both" | "none";
}

export const EDGE_RELATIONS: EdgeRelationMeta[] = [
  { id: "supports", label: "支持", color: "green", style: "solid", arrow: "target" },
  { id: "refutes", label: "反驳", color: "red", style: "dashed", arrow: "target" },
  { id: "causes", label: "因果", color: "orange", style: "solid", arrow: "target" },
  { id: "derives", label: "推导", color: "blue", style: "solid", arrow: "target" },
  { id: "source", label: "来源", color: "purple", style: "dashed", arrow: "target" },
  { id: "sequence", label: "顺序", color: "teal", style: "solid", arrow: "target" },
];

export const EDGE_RELATION_BY_ID = new Map<EdgeRelation, EdgeRelationMeta>(
  EDGE_RELATIONS.map((meta) => [meta.id, meta])
);
