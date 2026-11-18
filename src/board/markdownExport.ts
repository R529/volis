import type { BoardEdge } from "./types";
import type { OutlineItem, OutlineResult } from "./outline";

export type ExportFormat = "headings" | "list";

/** What the board knows about one node. Nothing here touches Obsidian APIs. */
export interface ExportNodeInfo {
  title: string;
  /** Everything after the node's first line; the first line is the heading. */
  body: string;
}

export interface ExportInput {
  boardTitle: string;
  outline: OutlineResult;
  infoOf: (id: string) => ExportNodeInfo;
  edges: BoardEdge[];
  titleOf: (id: string) => string;
}

interface Annotations {
  supports: string[];
  refutes: string[];
  sources: string[];
}

function emptyAnnotations(): Annotations {
  return { supports: [], refutes: [], sources: [] };
}

/**
 * `supports` / `refutes` / `source` never nest, so they become a short quote
 * block under the node they point at. The node on the tail of the arrow is the
 * annotator, which is where a reader expects to find it.
 */
function collectAnnotations(input: ExportInput): Map<string, Annotations> {
  const map = new Map<string, Annotations>();
  for (const edge of input.edges) {
    const relation = edge.relation;
    if (relation !== "supports" && relation !== "refutes" && relation !== "source") continue;
    if (edge.from === edge.to) continue;

    const label = edge.label?.trim();
    const title = input.titleOf(edge.from);
    const text = label ? `${title}（${label}）` : title;

    const bucket = map.get(edge.to) ?? emptyAnnotations();
    const list =
      relation === "supports"
        ? bucket.supports
        : relation === "refutes"
          ? bucket.refutes
          : bucket.sources;
    if (!list.includes(text)) list.push(text);
    map.set(edge.to, bucket);
  }
  return map;
}

function annotationLines(annotations: Annotations | undefined, indent: string): string[] {
  if (!annotations) return [];
  const lines: string[] = [];
  if (annotations.supports.length > 0) {
    lines.push(`${indent}> 支持：${annotations.supports.join("、")}`);
  }
  if (annotations.refutes.length > 0) {
    lines.push(`${indent}> 反驳：${annotations.refutes.join("、")}`);
  }
  if (annotations.sources.length > 0) {
    lines.push(`${indent}> 来源：${annotations.sources.join("、")}`);
  }
  return lines;
}

function heading(level: number, title: string): string {
  return `${"#".repeat(Math.min(level, 6))} ${title}`;
}

/** Body lines inside a list item need the item's indentation to stay inside it. */
function indentBody(body: string, indent: string): string[] {
  return body.split(/\r?\n/).map((line) => (line.trim() ? `${indent}${line}` : ""));
}

export function buildExportMarkdown(input: ExportInput, format: ExportFormat): string {
  const annotations = collectAnnotations(input);
  const out: string[] = [`# ${input.boardTitle}`, ""];

  const walk = (item: OutlineItem, depth: number): void => {
    const info = input.infoOf(item.id);
    const notes = annotations.get(item.id);
    const body = info.body.trim();

    if (format === "headings") {
      out.push("", heading(depth + 2, info.title));
      if (body) out.push("", body);
      const lines = annotationLines(notes, "");
      if (lines.length > 0) out.push("", ...lines);
    } else {
      const indent = "  ".repeat(depth);
      out.push(`${indent}- **${info.title}**`);
      if (body) out.push("", ...indentBody(body, `${indent}  `), "");
      const lines = annotationLines(notes, `${indent}  `);
      if (lines.length > 0) out.push(...lines);
    }

    for (const child of item.children) walk(child, depth + 1);
  };

  if (input.outline.roots.length > 0) {
    for (const root of input.outline.roots) walk(root, 0);
  } else {
    out.push("", "_白板上还没有节点。_");
  }

  // Lines without a semantic role cannot be expressed as hierarchy, so they
  // get their own section instead of disappearing from the export.
  const loose = input.edges.filter((edge) => !edge.relation && edge.from !== edge.to);
  if (loose.length > 0) {
    out.push("", "## 关联", "");
    for (const edge of loose) {
      const label = edge.label?.trim();
      const from = input.titleOf(edge.from);
      const to = input.titleOf(edge.to);
      out.push(`- ${from} → ${to}${label ? `：${label}` : ""}`);
    }
  }

  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
