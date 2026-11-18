import type { AIContextPolicy } from "../settings";

/**
 * Plain data handed to the budget builder. The board knows about nodes and
 * edges; this module knows about tokens. Keeping the boundary here means a new
 * node type only has to be mapped to `ContextNodeInput`.
 */
export interface ContextNodeInput {
  id: string;
  kind: "card" | "note" | "text" | "file" | "group";
  label: string;
  text: string;
  /** false for content the model genuinely cannot read (image, pdf, audio). */
  readable: boolean;
  /** Shown to the user when `readable` is false, e.g. "图片". */
  mediaKind?: string;
  meta?: { date?: string; time?: string; tags?: string[] };
  color?: string;
  /** File path for note/file nodes, so the model can talk about sources. */
  path?: string;
}

export interface ContextGroupInput {
  id: string;
  label: string;
  memberIds: string[];
}

export interface ContextEdgeInput {
  from: string;
  to: string;
  label?: string;
  /** Human-readable relation, e.g. "支持" or "反驳". */
  relation?: string;
}

export interface ContextInput {
  nodes: ContextNodeInput[];
  groups: ContextGroupInput[];
  edges: ContextEdgeInput[];
}

export interface SendNodeInfo {
  id: string;
  tag: string;
  label: string;
  kind: string;
  charsSent: number;
  charsTotal: number;
  truncated: boolean;
  readable: boolean;
  note?: string;
}

export interface SendManifest {
  nodes: SendNodeInfo[];
  omitted: Array<{ id: string; label: string; charsTotal: number }>;
  usedTokens: number;
  budgetTokens: number;
  /** Characters the budget worked out to after the measured ratio. */
  charBudget: number;
  /** Measured tokens-per-character for this batch. */
  ratio: number;
  /** "full" | "trimmed" | "partial" — what had to happen to make it fit. */
  stage: "full" | "trimmed" | "partial";
  notes: string[];
}

export interface ContextResult {
  text: string;
  manifest: SendManifest;
}

/**
 * Tokens per character, calibrated against real responses from this plugin
 * (121,171 Chinese characters → 69,688 input tokens ≈ 0.575). A flat 5% buffer
 * covers mixed content and tokenizer differences.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length;
  const other = text.length - cjk;
  return Math.ceil((cjk * 0.58 + other * 0.3) * 1.05);
}

/** What one node is allowed to contribute, in characters. */
function floorFor(node: ContextNodeInput, policy: AIContextPolicy): number {
  const smallest = policy.ladder[policy.ladder.length - 1] ?? 200;
  return node.kind === "note" || node.kind === "file" ? policy.noteFloorChars : smallest;
}

function capFor(node: ContextNodeInput, policy: AIContextPolicy): number {
  return node.kind === "note" || node.kind === "file" ? policy.noteCapChars : Number.MAX_SAFE_INTEGER;
}

interface Allocation {
  allowed: number[];
  omitted: number[];
}

/**
 * Hands out a character budget: everyone gets a floor first, the remainder is
 * split by how much each node still wants. Notes are capped so one long note
 * cannot starve twenty cards.
 */
function allocate(sizes: number[], floors: number[], caps: number[], charBudget: number): Allocation {
  const allowed = sizes.map((size, i) => Math.min(size, Math.min(floors[i], caps[i])));
  const omitted: number[] = [];

  let used = allowed.reduce((sum, value) => sum + value, 0);

  // Even the floors do not fit: keep nodes in board order and drop the rest.
  if (used > charBudget) {
    let left = charBudget;
    for (let i = 0; i < allowed.length; i += 1) {
      const take = Math.min(Math.min(sizes[i], caps[i]), left);
      allowed[i] = take;
      left -= take;
      if (take <= 0) omitted.push(i);
    }
    return { allowed, omitted };
  }

  let left = charBudget - used;

  for (let round = 0; round < 3 && left > 0; round += 1) {
    const weights = sizes.map((size, i) => Math.max(0, Math.min(size, caps[i]) - allowed[i]));
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    if (totalWeight <= 0) break;

    let distributed = 0;
    for (let i = 0; i < allowed.length; i += 1) {
      if (weights[i] <= 0) continue;
      const share = Math.floor((left * weights[i]) / totalWeight);
      const take = Math.min(share, weights[i]);
      if (take <= 0) continue;
      allowed[i] += take;
      distributed += take;
    }

    if (distributed <= 0) break;
    left -= distributed;
  }

  return { allowed, omitted };
}

function cleanBody(text: string, limit: number): { text: string; truncated: boolean } {
  const flat = (text ?? "").replace(/\r\n/g, "\n").trim();
  if (flat.length <= limit) return { text: flat, truncated: false };

  // The truncation notice counts against the cap, so the total never exceeds it.
  const suffix = `…（原文 ${flat.length} 字，已截断）`;
  const keep = Math.max(0, limit - suffix.length);
  return { text: flat.slice(0, keep) + suffix, truncated: true };
}

/**
 * Builds the board description that fits `budgetTokens`, and reports exactly
 * what was sent. The manifest is what the panel shows the user — nothing is
 * trimmed silently.
 */
export function buildBoardContext(
  input: ContextInput,
  budgetTokens: number,
  policy: AIContextPolicy
): ContextResult {
  const contentNodes = input.nodes.filter((node) => node.kind !== "group");
  const tagOf = new Map<string, string>();
  contentNodes.forEach((node, i) => tagOf.set(node.id, `N${i + 1}`));

  // Group headers and relation lines are cheap but not free: reserve them first.
  const groupLines: string[] = [];
  for (const group of input.groups) {
    const tags = group.memberIds
      .map((id) => tagOf.get(id))
      .filter((tag): tag is string => Boolean(tag));
    if (tags.length > 0) {
      groupLines.push(`【分组】「${group.label}」包含 ${tags.join("、")}`);
    } else if (group.memberIds.length > 0) {
      groupLines.push(`【分组】「${group.label}」里有 ${group.memberIds.length} 个节点，本次未发送`);
    }
  }

  const edgeLines = input.edges
    .filter((edge) => tagOf.has(edge.from) && tagOf.has(edge.to))
    .map((edge) => {
      const label = edge.label ? `（${edge.label}）` : "";
      const relation = edge.relation ? ` -[${edge.relation}]-> ` : " → ";
      return `${tagOf.get(edge.from)}${relation}${tagOf.get(edge.to)}${label}`;
    });

  const overheadChars =
    groupLines.join("\n").length + edgeLines.join("\n").length + 120;

  const bodies = contentNodes.map((node) => (node.readable ? (node.text ?? "") : ""));
  const totalChars = bodies.reduce((sum, body) => sum + body.length, 0);

  // Measure this batch instead of trusting a constant: mixed boards differ.
  const ratio = totalChars > 200 ? estimateTokens(bodies.join("")) / totalChars : 0.58;
  const charBudget = Math.max(0, Math.floor((budgetTokens - overheadChars * ratio) / Math.max(0.2, ratio)));

  const sizes = bodies.map((body) => body.length);
  const floors = contentNodes.map((node) => floorFor(node, policy));
  const caps = contentNodes.map((node) => capFor(node, policy));

  const compose = (budgetChars: number): ContextResult => {
    const { allowed, omitted } = allocate(sizes, floors, caps, budgetChars);

    const cells: string[] = [];
    const nodes: SendNodeInfo[] = [];

    contentNodes.forEach((node, i) => {
      const tag = tagOf.get(node.id) ?? `N${i + 1}`;
      const body = bodies[i];

      if (omitted.includes(i)) {
        nodes.push({
          id: node.id,
          tag,
          label: node.label,
          kind: node.kind,
          charsSent: 0,
          charsTotal: body.length,
          truncated: false,
          readable: node.readable,
          note: "预算不足，未发送",
        });
        return;
      }

      const { text, truncated } = node.readable
        ? cleanBody(body, allowed[i])
        : { text: "", truncated: false };

      const bits: string[] = [kindLabel(node.kind)];
      if (node.meta?.date) {
        bits.push(node.meta.date + (node.meta.time ? ` ${node.meta.time}` : ""));
      }
      if (node.meta?.tags?.length) {
        bits.push(node.meta.tags.map((tagText) => `#${tagText}`).join(" "));
      }
      if (node.color) bits.push(`颜色:${node.color}`);
      if (node.path) bits.push(`来源:${node.path}`);

      let content = text || "（空）";
      if (!node.readable) {
        content = `（${node.mediaKind ?? "文件"}，本次只发送了文件名，正文未解析）`;
      } else if (node.kind === "note" || node.kind === "file") {
        if (!body.trim()) content = "（笔记内容为空或未读取到）";
      }

      cells.push(`【${tag}】${bits.join(" · ")}\n${content}`);
      nodes.push({
        id: node.id,
        tag,
        label: node.label,
        kind: node.kind,
        charsSent: text.length,
        charsTotal: body.length,
        truncated,
        readable: node.readable,
        note: truncated ? "已截断" : undefined,
      });
    });

    const sentCount = nodes.filter((node) => node.charsSent > 0 || !node.readable).length;
    const droppedCount = nodes.length - sentCount;
    const truncatedAny = nodes.some((node) => node.truncated);

    const sections: string[] = [];
    if (groupLines.length > 0) sections.push(groupLines.join("\n"));
    sections.push(...cells);
    if (edgeLines.length > 0) sections.push(`【关系】\n${edgeLines.join("\n")}`);
    if (droppedCount > 0) {
      sections.push(
        `【说明】本次只发送了 ${sentCount} 个节点，还有 ${droppedCount} 个因为上下文预算不足没有发送。` +
          "回答时如需引用未发送的节点，请先说明这一点。"
      );
    }

    const text = sections.join("\n\n");

    const notes: string[] = [];
    if (droppedCount > 0) notes.push(`预算不足，${droppedCount} 个节点未发送`);
    if (truncatedAny) {
      const count = nodes.filter((node) => node.truncated).length;
      notes.push(`${count} 个节点内容被截断`);
    }
    const unreadable = nodes.filter((node) => !node.readable).length;
    if (unreadable > 0) notes.push(`${unreadable} 个节点只发送了文件名`);

    return {
      text,
      manifest: {
        nodes,
        omitted: nodes
          .filter((node) => node.note === "预算不足，未发送")
          .map((node) => ({ id: node.id, label: node.label, charsTotal: node.charsTotal })),
        usedTokens: estimateTokens(text),
        budgetTokens,
        charBudget: budgetChars,
        ratio,
        stage: droppedCount > 0 ? "partial" : truncatedAny ? "trimmed" : "full",
        notes,
      },
    };
  };

  let budgetChars = charBudget;
  let result = compose(budgetChars);

  // The estimate can drift on mixed content. Measure what was built and shrink
  // once or twice rather than hand the provider a request it will reject.
  for (let i = 0; i < 2 && result.manifest.usedTokens > budgetTokens && budgetChars > 0; i += 1) {
    budgetChars = Math.max(0, Math.floor((budgetChars * budgetTokens) / result.manifest.usedTokens) - 1);
    result = compose(budgetChars);
  }

  return result;
}

function kindLabel(kind: ContextNodeInput["kind"]): string {
  if (kind === "card") return "卡片";
  if (kind === "note") return "笔记";
  if (kind === "text") return "文本节点";
  return "文件";
}
