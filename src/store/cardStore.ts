import { App, TFile } from "obsidian";
import { CardMeta, CardRef } from "../types";
import { buildBlockLines, locateBlock, readBlockContent } from "../parse/blockLocator";

const TAG_RE = /(^|\s)#([^\s#[\]()]+)/g;
const TIME_RE = /^\s*(\d{1,2}:\d{2})\s/;
const DATE_RE = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/;

export function extractTags(body: string): string[] {
  const out: string[] = [];
  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(body)) !== null) {
    const tag = match[2];
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

export async function readCard(app: App, ref: CardRef): Promise<CardMeta> {
  const file = app.vault.getAbstractFileByPath(ref.file);
  if (!(file instanceof TFile)) {
    return { ref, body: "", timePrefix: "", editable: "", tags: [], stale: true };
  }

  const content = await app.vault.cachedRead(file);
  const lines = content.split("\n");
  const range = locateBlock(lines, ref.blockId);
  if (!range) {
    return { ref, body: "", timePrefix: "", editable: "", tags: [], stale: true };
  }

  const block = readBlockContent(lines, range, ref.blockId);
  const body = block.body;
  const tags = extractTags(body);

  let date: string | undefined;
  for (let i = range.start - 1; i >= 0; i--) {
    const match = lines[i].match(DATE_RE);
    if (match) {
      date = match[1];
      break;
    }
  }

  const timeMatch = body.match(TIME_RE);
  const timePrefix = timeMatch ? timeMatch[0] : "";
  const editable = timePrefix ? body.slice(timePrefix.length) : body;

  return {
    ref,
    body,
    timePrefix,
    editable,
    tags,
    date,
    time: timeMatch ? timeMatch[1] : undefined,
    stale: false,
  };
}

export async function writeCard(app: App, ref: CardRef, newBody: string): Promise<boolean> {
  const file = app.vault.getAbstractFileByPath(ref.file);
  if (!(file instanceof TFile)) return false;

  let written = false;
  await app.vault.process(file, (content) => {
    const lines = content.split("\n");
    const range = locateBlock(lines, ref.blockId);
    if (!range) return content;

    const block = readBlockContent(lines, range, ref.blockId);
    const replacement = buildBlockLines(newBody, block.firstPrefix, block.contIndent, ref.blockId);
    lines.splice(range.start, range.end - range.start + 1, ...replacement);
    written = true;
    return lines.join("\n");
  });

  return written;
}

export async function listCardsInFile(app: App, filePath: string): Promise<CardRef[]> {
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) return [];

  const content = await app.vault.cachedRead(file);
  const lines = content.split("\n");
  const idRe = /(?:^|[ \t])\^([A-Za-z0-9-]+)[ \t]*$/;
  const refs: CardRef[] = [];

  const base = file.path.replace(/\.md$/, "");
  lines.forEach((line) => {
    const match = line.match(idRe);
    if (match) refs.push({ file: file.path, blockId: match[1], linkpath: base });
  });

  return refs;
}
