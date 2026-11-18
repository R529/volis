/**
 * Read-only health check for a board.
 *
 * Every rule here is deterministic and works on plain board data. Nothing in
 * this module writes, deletes or even talks to Obsidian: the caller decides
 * whether an issue is worth showing, and the user decides whether to act.
 * Fixes live in the board view and reuse its existing, undoable operations.
 */

import { BoardEdge, BoardNode, CardNode, GroupNode } from "./types";

export type DoctorLevel = "error" | "warning" | "hint";

export type DoctorKind =
  | "stale-ref"
  | "dangling-edge"
  | "duplicate-ref"
  | "duplicate-text"
  | "unlabeled-edge"
  | "isolated-node"
  | "overlap"
  | "far-away"
  | "empty-node"
  | "empty-group";

export interface DoctorIssue {
  /** Stable within one scan, used as the render key. */
  key: string;
  level: DoctorLevel;
  kind: DoctorKind;
  title: string;
  detail: string;
  /** Nodes the report can jump to. */
  nodeIds: string[];
  /** Set for issues on a connection. */
  edgeId?: string;
  /** Set only for issues with an explicit remove fix. */
  removableNodeId?: string;
}

export interface DoctorInput {
  nodes: BoardNode[];
  edges: BoardEdge[];
  /** Reuses the view's existing block-reference check; no extra vault reads. */
  staleIds: ReadonlySet<string>;
  textOf: (node: BoardNode) => string;
  heightOf: (node: BoardNode) => number;
  memberIdsOf: (group: GroupNode) => string[];
}

/** Short, human-readable name for a node, shared by the report and confirms. */
export function doctorNodeName(node: BoardNode): string {
  if (node.type === "group") return node.label?.trim() || "未命名分组";
  if (node.type === "text") {
    const first = node.text.split("\n").find((line) => line.trim()) ?? "";
    return first.trim().slice(0, 20) || "空白文本";
  }
  return node.file.split("/").pop() || node.file;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Normalise body text for a conservative near-duplicate check: whitespace and
 * punctuation are ignored, but word order and content must still match.
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。！？、；：,.!?;:'"“”‘’()（）[\]{}<>《》\-—_]/g, "");
}

const LEVEL_ORDER: Record<DoctorLevel, number> = { error: 0, warning: 1, hint: 2 };
const KIND_ORDER: DoctorKind[] = [
  "stale-ref",
  "dangling-edge",
  "duplicate-ref",
  "duplicate-text",
  "unlabeled-edge",
  "isolated-node",
  "overlap",
  "far-away",
  "empty-node",
  "empty-group",
];

export function scanBoard(input: DoctorInput): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const present = (id: string): boolean => byId.has(id);
  const name = (id: string): string => {
    const node = byId.get(id);
    return node ? doctorNodeName(node) : "已删除的节点";
  };

  // A card whose source file or block id no longer exists. The view already
  // tracks this for its badges and its old one-click cleanup button.
  for (const node of input.nodes) {
    if (node.type !== "card" || !input.staleIds.has(node.id)) continue;
    issues.push({
      key: `stale:${node.id}`,
      level: "error",
      kind: "stale-ref",
      title: "引用失效",
      detail: `${doctorNodeName(node)} 的块引用在源笔记里找不到，卡片正文为空`,
      nodeIds: [node.id],
      removableNodeId: node.id,
    });
  }

  // A line whose endpoints are gone. Normal deletions prune these already;
  // this catches hand-edited files and interrupted writes.
  const danglingNodeIds = new Set<string>();
  for (const edge of input.edges) {
    if (present(edge.from) && present(edge.to)) continue;
    danglingNodeIds.add(edge.from);
    danglingNodeIds.add(edge.to);
    issues.push({
      key: `dangling:${edge.id}`,
      level: "error",
      kind: "dangling-edge",
      title: "连线端点丢失",
      detail: `${name(edge.from)} → ${name(edge.to)} 中有一端已不在白板上`,
      nodeIds: [],
      edgeId: edge.id,
    });
  }

  // Exact duplicate block references are certain; report one issue per extra
  // node and offer to remove that one, never the first.
  const byRef = new Map<string, CardNode[]>();
  for (const node of input.nodes) {
    if (node.type !== "card") continue;
    const ref = `${node.file}#^${node.blockId}`;
    const list = byRef.get(ref) ?? [];
    list.push(node);
    byRef.set(ref, list);
  }

  const duplicatePairs = new Set<string>();
  for (const [ref, list] of byRef) {
    if (list.length < 2) continue;
    for (let i = 1; i < list.length; i++) {
      const first = list[0];
      const duplicate = list[i];
      duplicatePairs.add(pairKey(first.id, duplicate.id));
      issues.push({
        key: `dupref:${duplicate.id}`,
        level: "warning",
        kind: "duplicate-ref",
        title: "重复卡片",
        detail: `${ref.split("/").pop()} 在白板上出现了 ${list.length} 次`,
        nodeIds: [first.id, duplicate.id],
        removableNodeId: duplicate.id,
      });
    }
  }

  // Near-duplicate prose is only a hint: two long notes can legitimately
  // overlap. Keep the comparison cheap and skip pairs already caught above.
  const texts = input.nodes
    .filter((node) => node.type !== "group" && !input.staleIds.has(node.id))
    .slice(0, 300)
    .map((node) => ({ node, text: normalise(input.textOf(node)) }))
    .filter((item) => item.text.length >= 24);

  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i];
      const b = texts[j];
      if (duplicatePairs.has(pairKey(a.node.id, b.node.id))) continue;

      const longer = a.text.length >= b.text.length ? a.text : b.text;
      const shorter = a.text.length >= b.text.length ? b.text : a.text;
      const similar =
        a.text === b.text ||
        (shorter.length >= longer.length * 0.8 && longer.includes(shorter));
      if (!similar) continue;

      issues.push({
        key: `duptext:${a.node.id}:${b.node.id}`,
        level: "warning",
        kind: "duplicate-text",
        title: "正文高度相似",
        detail: `「${doctorNodeName(a.node)}」与「${doctorNodeName(b.node)}」的正文几乎一样，请人工确认`,
        nodeIds: [a.node.id, b.node.id],
      });
    }
  }

  // A label or a relation is the semantic payload a connection carries into
  // AI context; either one is enough.
  for (const edge of input.edges) {
    if (!present(edge.from) || !present(edge.to)) continue;
    if (edge.label?.trim() || edge.relation) continue;
    issues.push({
      key: `unlabeled:${edge.id}`,
      level: "warning",
      kind: "unlabeled-edge",
      title: "连线没有语义",
      detail: `${name(edge.from)} → ${name(edge.to)} 只有方向，建议加标签或关系`,
      nodeIds: [],
      edgeId: edge.id,
    });
  }

  // Nodes with no usable connection. Endpoints of dangling lines are skipped
  // so one broken edge does not produce two different complaints.
  const connected = new Set<string>();
  for (const edge of input.edges) {
    if (!present(edge.from) || !present(edge.to)) continue;
    connected.add(edge.from);
    connected.add(edge.to);
  }
  for (const node of input.nodes) {
    if (node.type === "group") continue;
    if (connected.has(node.id) || danglingNodeIds.has(node.id)) continue;
    issues.push({
      key: `isolated:${node.id}`,
      level: "hint",
      kind: "isolated-node",
      title: "孤立节点",
      detail: `「${doctorNodeName(node)}」没有任何连线，确认是不是漏画了关系`,
      nodeIds: [node.id],
    });
  }

  // Significant overlap between two real nodes. Groups are excluded because
  // containing other nodes is exactly what a group is for.
  const boxes = input.nodes
    .filter((node) => node.type !== "group")
    .slice(0, 400)
    .map((node) => ({
      node,
      x: node.x,
      y: node.y,
      w: node.width,
      h: Math.max(1, input.heightOf(node)),
    }));

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ix <= 0 || iy <= 0) continue;
      if (ix * iy < Math.min(a.w * a.h, b.w * b.h) * 0.4) continue;

      issues.push({
        key: `overlap:${a.node.id}:${b.node.id}`,
        level: "hint",
        kind: "overlap",
        title: "节点重叠",
        detail: `「${doctorNodeName(a.node)}」与「${doctorNodeName(b.node)}」大面积重叠`,
        nodeIds: [a.node.id, b.node.id],
      });
    }
  }

  // One node parked far outside the rest of the board. Its text still enters
  // AI context, so it is worth surfacing even though nothing is broken.
  if (input.nodes.length >= 4) {
    const others = input.nodes.filter((node) => node.type !== "group");
    for (const node of others) {
      if (others.length < 4) break;
      const rest = others.filter((other) => other.id !== node.id);
      if (rest.length === 0) continue;
      const minX = Math.min(...rest.map((item) => item.x));
      const maxX = Math.max(...rest.map((item) => item.x + item.width));
      const minY = Math.min(...rest.map((item) => item.y));
      const maxY = Math.max(
        ...rest.map((item) => item.y + Math.max(1, input.heightOf(item)))
      );
      const gapX = Math.max(0, minX - (node.x + node.width), node.x - maxX);
      const gapY = Math.max(
        0,
        minY - (node.y + input.heightOf(node)),
        node.y - maxY
      );
      if (Math.hypot(gapX, gapY) < 1200) continue;

      issues.push({
        key: `far:${node.id}`,
        level: "hint",
        kind: "far-away",
        title: "远离内容区",
        detail: `「${doctorNodeName(node)}」离其他节点很远，仍在 AI 上下文里占额度`,
        nodeIds: [node.id],
      });
    }
  }

  for (const node of input.nodes) {
    if (node.type === "text" && !node.text.trim()) {
      issues.push({
        key: `empty:${node.id}`,
        level: "hint",
        kind: "empty-node",
        title: "空白文本节点",
        detail: "这个文本节点没有内容，AI 会读到占位符",
        nodeIds: [node.id],
      });
    }
    if (node.type === "group" && input.memberIdsOf(node).length === 0) {
      issues.push({
        key: `emptygroup:${node.id}`,
        level: "hint",
        kind: "empty-group",
        title: "空分组",
        detail: `分组「${doctorNodeName(node)}」里没有节点`,
        nodeIds: [node.id],
      });
    }
  }

  return issues.sort((a, b) => {
    const byLevel = LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level];
    if (byLevel !== 0) return byLevel;
    const byKind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    return byKind !== 0 ? byKind : a.key.localeCompare(b.key);
  });
}
