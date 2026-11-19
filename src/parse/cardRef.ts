import { App } from "obsidian";
import { CardRef } from "../types";

const BLOCK_LINK_RE = /\[\[([^[\]|#]+?)#\^([^[\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;

export interface ParsedLink {
  linkpath: string;
  blockId: string;
  alias?: string;
}

export function extractBlockLinks(text: string): ParsedLink[] {
  const out: ParsedLink[] = [];
  BLOCK_LINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BLOCK_LINK_RE.exec(text)) !== null) {
    const linkpath = match[1].trim();
    const blockId = match[2].trim();
    if (!linkpath || !blockId) continue;
    out.push({ linkpath, blockId, alias: match[3] ? match[3].trim() : undefined });
  }
  return out;
}

export function resolveCardRef(app: App, sourcePath: string, text: string): CardRef | null {
  const links = extractBlockLinks(text);
  if (links.length === 0) return null;
  const first = links[0];
  const dest = app.metadataCache.getFirstLinkpathDest(first.linkpath, sourcePath);
  if (!dest) return null;
  return { file: dest.path, blockId: first.blockId, linkpath: first.linkpath };
}

export function makeBlockLink(ref: CardRef): string {
  return `![[${ref.linkpath}#^${ref.blockId}]]`;
}
