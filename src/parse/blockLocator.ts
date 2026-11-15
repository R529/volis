import { BlockContent, BlockRange } from "../types";

const LIST_START = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]/;
const ANY_BLOCK_ID = /(?:^|[ \t])\^[A-Za-z0-9-]+[ \t]*$/;

export function indentOf(line: string): number {
  const match = line.match(/^[ \t]*/);
  if (!match) return 0;
  return match[0].replace(/\t/g, "  ").length;
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Locate the block that owns a block id.
 * Walks upward from the id line until it hits a blank line or a top level list
 * item, so multi-line cards (list item + indented continuation) stay intact.
 */
export function locateBlock(lines: string[], blockId: string): BlockRange | null {
  const endRe = new RegExp(`(?:^|[ \\t])\\^${escapeRe(blockId)}[ \\t]*$`);
  let idLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (endRe.test(lines[i])) idLine = i;
  }
  if (idLine === -1) return null;

  let start = idLine;
  for (let i = idLine; i > 0; i--) {
    const prev = lines[i - 1];
    if (prev.trim() === "") break;

    // Another card's id marks the end of the previous block: stop before
    // swallowing it, otherwise two neighbouring cards merge into one.
    if (ANY_BLOCK_ID.test(prev)) break;

    start = i - 1;
    if (LIST_START.test(prev) && indentOf(prev) === 0) break;
  }
  return { start, end: idLine };
}

export function readBlockContent(
  lines: string[],
  range: BlockRange,
  blockId: string
): BlockContent {
  const blockLines = lines.slice(range.start, range.end + 1);
  const firstLine = blockLines[0] ?? "";
  const prefixMatch = firstLine.match(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/);
  const firstPrefix = prefixMatch ? prefixMatch[0] : "";

  let contIndent = "";
  if (blockLines.length > 1) {
    const indentMatch = blockLines[1].match(/^[ \t]+/);
    if (indentMatch) contIndent = indentMatch[0];
  }

  const raw = blockLines.slice();
  if (raw.length > 0 && firstPrefix) {
    raw[0] = raw[0].slice(firstPrefix.length);
  }

  const lastIndex = raw.length - 1;
  const idRe = new RegExp(`[ \\t]*\\^${escapeRe(blockId)}[ \\t]*$`);
  if (lastIndex >= 0) {
    raw[lastIndex] = raw[lastIndex].replace(idRe, "").replace(/[ \t]+$/, "");
  }

  for (let i = 1; i < raw.length; i++) {
    if (contIndent && raw[i].startsWith(contIndent)) {
      raw[i] = raw[i].slice(contIndent.length);
    } else {
      raw[i] = raw[i].replace(/^[ \t]{1,2}/, "");
    }
  }

  const body = raw
    .join("\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n+$/, "");

  return {
    range,
    body,
    firstPrefix,
    contIndent: contIndent || "  ",
    idLine: blockLines[blockLines.length - 1] ?? "",
  };
}

export function buildBlockLines(
  body: string,
  firstPrefix: string,
  contIndent: string,
  blockId: string
): string[] {
  const normalized = body.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const bodyLines = normalized.split("\n");
  const out: string[] = [];

  bodyLines.forEach((line, index) => {
    if (index === 0) out.push(`${firstPrefix}${line}`);
    else out.push(`${contIndent}${line}`);
  });

  if (out.length === 0) out.push(firstPrefix);

  const last = out.length - 1;
  out[last] = `${out[last].replace(/[ \t]+$/, "")} ^${blockId}`;
  return out;
}
