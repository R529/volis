import type { BoardEdge } from "./types";

/** What the board supplies for one outline row. Kept separate from the node so
 *  this module never touches Obsidian APIs. */
export interface OutlineInfo {
  title: string;
  snippet?: string;
}

export type OutlineKind = "card" | "text" | "file" | "group";

export interface OutlineNodeInput {
  id: string;
  x: number;
  y: number;
  kind: OutlineKind;
}

export interface OutlineBadges {
  supports: number;
  refutes: number;
  source: number;
}

export interface OutlineItem extends OutlineInfo {
  id: string;
  kind: OutlineKind;
  /** Set when this row is a child rather than a root. */
  relation?: "derives" | "causes";
  badges: OutlineBadges;
  children: OutlineItem[];
}

export interface OutlineResult {
  roots: OutlineItem[];
  nodeCount: number;
  hasHierarchy: boolean;
  hasSequence: boolean;
  /** True when a structural edge had to be skipped to keep the tree acyclic. */
  cycle: boolean;
}

type StructuralRelation = "derives" | "causes";

interface Candidate {
  parent: string;
  relation: StructuralRelation;
  y: number;
  x: number;
}

function emptyBadges(): OutlineBadges {
  return { supports: 0, refutes: 0, source: 0 };
}

function byPosition(
  a: string,
  b: string,
  nodeById: Map<string, OutlineNodeInput>
): number {
  const na = nodeById.get(a);
  const nb = nodeById.get(b);
  if (!na || !nb) return a.localeCompare(b);
  return na.y - nb.y || na.x - nb.x || a.localeCompare(b);
}

/**
 * Order one sibling set. `sequence` edges define a partial order; anything the
 * edges leave undecided falls back to board position, so the outline still
 * reads top-to-bottom when a board has no sequence lines at all.
 */
function orderSiblings(
  ids: string[],
  seqOut: Map<string, Set<string>>,
  nodeById: Map<string, OutlineNodeInput>
): string[] {
  if (ids.length <= 1) return ids.slice();

  const present = new Set(ids);
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, Set<string>>();

  for (const id of ids) indegree.set(id, 0);

  for (const id of ids) {
    const targets = seqOut.get(id);
    if (!targets) continue;
    for (const to of targets) {
      if (!present.has(to) || to === id) continue;
      const bucket = outgoing.get(id) ?? new Set<string>();
      if (bucket.has(to)) continue;
      bucket.add(to);
      outgoing.set(id, bucket);
      indegree.set(to, (indegree.get(to) ?? 0) + 1);
    }
  }

  const ready = ids
    .filter((id) => (indegree.get(id) ?? 0) === 0)
    .sort((a, b) => byPosition(a, b, nodeById));

  const ordered: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as string;
    ordered.push(id);
    for (const to of outgoing.get(id) ?? []) {
      const next = (indegree.get(to) ?? 0) - 1;
      indegree.set(to, next);
      if (next === 0) {
        ready.push(to);
        ready.sort((a, b) => byPosition(a, b, nodeById));
      }
    }
  }

  // A sequence cycle leaves rows undecided; keep them visible by position
  // instead of silently dropping them.
  if (ordered.length < ids.length) {
    const seen = new Set(ordered);
    const rest = ids.filter((id) => !seen.has(id));
    rest.sort((a, b) => byPosition(a, b, nodeById));
    ordered.push(...rest);
  }

  return ordered;
}

/**
 * Turns the board graph into a readable tree.
 *
 * - `derives` and `causes` are the only relations that create nesting.
 * - `sequence` orders siblings; it never nests.
 * - `supports`, `refutes` and `source` become badges on the row they point at.
 * - Unconnected nodes, and nodes only touched by annotation edges, are roots.
 * - Group frames appear only when they take part in a relation; an untouched
 *   frame is a spatial container, not part of the argument.
 */
export function buildOutline(
  nodes: OutlineNodeInput[],
  edges: BoardEdge[],
  infoOf: (node: OutlineNodeInput) => OutlineInfo
): OutlineResult {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const active = new Set<string>();
  let cycle = false;

  for (const edge of edges) {
    if (!edge.relation) continue;
    if (edge.from === edge.to) continue;
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
    active.add(edge.from);
    active.add(edge.to);
  }

  const included = nodes.filter(
    (node) => node.kind !== "group" || active.has(node.id)
  );
  const includedIds = new Set(included.map((node) => node.id));

  const candidates = new Map<string, Candidate[]>();
  const badges = new Map<string, OutlineBadges>();
  const seqOut = new Map<string, Set<string>>();
  let hasSequence = false;

  for (const edge of edges) {
    if (!edge.relation) continue;
    if (!includedIds.has(edge.from) || !includedIds.has(edge.to)) continue;
    if (edge.from === edge.to) {
      cycle = true;
      continue;
    }

    if (edge.relation === "derives" || edge.relation === "causes") {
      const parent = nodeById.get(edge.from);
      if (!parent) continue;
      const list = candidates.get(edge.to) ?? [];
      list.push({
        parent: edge.from,
        relation: edge.relation,
        y: parent.y,
        x: parent.x,
      });
      candidates.set(edge.to, list);
      continue;
    }

    if (edge.relation === "sequence") {
      hasSequence = true;
      const bucket = seqOut.get(edge.from) ?? new Set<string>();
      bucket.add(edge.to);
      seqOut.set(edge.from, bucket);
      continue;
    }

    const counts = badges.get(edge.to) ?? emptyBadges();
    counts[edge.relation] += 1;
    badges.set(edge.to, counts);
  }

  // A node may list several parents. Prefer the strongest structural relation,
  // then the parent that sits highest on the board, so the result is stable.
  for (const list of candidates.values()) {
    list.sort((a, b) => {
      const rank = (relation: StructuralRelation) => (relation === "derives" ? 0 : 1);
      return (
        rank(a.relation) - rank(b.relation) ||
        a.y - b.y ||
        a.x - b.x ||
        a.parent.localeCompare(b.parent)
      );
    });
  }

  const parentOf = new Map<string, { parent: string; relation: StructuralRelation }>();
  let hasHierarchy = false;

  for (const node of included) {
    const list = candidates.get(node.id);
    if (!list) continue;

    for (const candidate of list) {
      if (candidate.parent === node.id) {
        cycle = true;
        continue;
      }

      // Adding this parent would close a loop if the child is already an
      // ancestor of the would-be parent.
      let current: string | undefined = candidate.parent;
      let loops = false;
      let guard = 0;
      while (current && guard < 10000) {
        guard += 1;
        if (current === node.id) {
          loops = true;
          break;
        }
        current = parentOf.get(current)?.parent;
      }

      if (loops) {
        cycle = true;
        continue;
      }

      parentOf.set(node.id, {
        parent: candidate.parent,
        relation: candidate.relation,
      });
      hasHierarchy = true;
      break;
    }
  }

  const childrenOf = new Map<string, string[]>();
  for (const node of included) {
    const parent = parentOf.get(node.id);
    if (!parent) continue;
    const list = childrenOf.get(parent.parent) ?? [];
    list.push(node.id);
    childrenOf.set(parent.parent, list);
  }

  const buildItem = (id: string): OutlineItem => {
    const node = nodeById.get(id);
    const info = node ? infoOf(node) : { title: "未命名" };
    const kids = orderSiblings(childrenOf.get(id) ?? [], seqOut, nodeById);

    return {
      id,
      kind: node?.kind ?? "text",
      title: info.title || "未命名",
      snippet: info.snippet,
      relation: parentOf.get(id)?.relation,
      badges: badges.get(id) ?? emptyBadges(),
      children: kids.map(buildItem),
    };
  };

  const roots = included
    .filter((node) => !parentOf.has(node.id))
    .map((node) => node.id);

  return {
    roots: orderSiblings(roots, seqOut, nodeById).map(buildItem),
    nodeCount: included.length,
    hasHierarchy,
    hasSequence,
    cycle,
  };
}
