/** Board access for the board wall. Reads real .volis files, writes new ones
 *  into the dedicated folder. Nothing here changes volis's own board logic. */

import type { App, TAbstractFile, TFile } from "obsidian";
import { TFile as TFileClass } from "obsidian";
import { BOARD_EXTENSION, blankBoardData, nextBoardPath } from "../board/boardStore";
import type { BoardData, BoardNode } from "../board/types";
import type { BoardItem, MiniEdge, MiniNode } from "./types";

const PAD = 7;
const MAX_NODES = 14;
const MAX_CARDS = 6;
const TEXT_CAP = 96;

/** Block excerpts, keyed by `path@mtime`. Reading a block costs a file read,
 *  and the wall redraws on every board save, so the cache matters. */
const blockCache = new Map<string, string>();

function clean(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/[*_`>#~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cut(text: string, max = TEXT_CAP): string {
  const value = clean(text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function baseName(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.[^.]+$/, "");
}

/** Hex colours go through as-is; named colours become a `data-tone` hook so the
 *  theme decides the actual value. */
function toneOf(node: BoardNode): string {
  const color = (node as { color?: string }).color;
  if (!color) return "";
  return color;
}

async function blockText(app: App, node: BoardNode): Promise<string> {
  if (node.type !== "card") return "";
  const card = node as { file?: string; blockId?: string };
  if (!card.file || !card.blockId) return "";
  const file = app.vault.getAbstractFileByPath(card.file);
  if (!(file instanceof TFileClass)) return "";
  const key = `${file.path}@${file.stat.mtime}`;
  const cached = blockCache.get(key);
  if (cached !== undefined) return cached;

  let excerpt = "";
  try {
    const content = await app.vault.cachedRead(file);
    const marker = `^${card.blockId}`;
    const lines = content.split(/\r?\n/);
    // The block id sits at the end of its block; walk back to the block start
    // so a list item or quote keeps the first line as the excerpt.
    const at = lines.findIndex((line) => line.includes(marker));
    if (at >= 0) {
      const parts: string[] = [lines[at].replace(marker, "")];
      for (let i = at - 1; i >= 0 && parts.length < 4; i--) {
        const line = lines[i];
        if (!line.trim() || /^#{1,6}\s/.test(line) || /^(---|\*\*\*)/.test(line)) break;
        parts.unshift(line);
      }
      excerpt = cut(parts.join(" "), 140);
    }
  } catch {
    excerpt = "";
  }
  if (blockCache.size > 300) blockCache.clear();
  blockCache.set(key, excerpt);
  return excerpt;
}

function labelOf(node: BoardNode, cardText: string): string {
  if (node.type === "text") return cut((node as { text?: string }).text ?? "");
  if (node.type === "file") return cut(baseName((node as { file?: string }).file ?? ""), 40);
  if (node.type === "card") return cardText || cut(baseName((node as { file?: string }).file ?? ""), 40);
  if (node.type === "group") return cut((node as { label?: string }).label ?? "", 28);
  return "";
}

/** Lays the board's own nodes out inside a 0–100 square, so the card cover is a
 *  real miniature of the board rather than a decorative pattern. */
function layout(data: BoardData, labels: Map<string, string>) {
  const nodes = (data.nodes ?? []).filter(
    (node) =>
      node.type !== "group" &&
      Number.isFinite(node.x) &&
      Number.isFinite(node.y) &&
      node.width > 0,
  );
  if (!nodes.length) return { nodes: [] as MiniNode[], edges: [] as MiniEdge[] };

  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + n.width));
  const maxY = Math.max(...nodes.map((n) => n.y + (n.height ?? 120)));
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const area = 100 - PAD * 2;
  // Keep the miniature's aspect ratio close to the board's real one instead of
  // stretching everything to a square: a wide board should look wide.
  const ratio = spanX / spanY;
  const boxW = ratio >= 1 ? area : area * ratio;
  const boxH = ratio >= 1 ? area / ratio : area;
  const offX = PAD + (area - boxW) / 2;
  const offY = PAD + (area - boxH) / 2;

  const pick = [...nodes]
    .sort((a, b) => b.width * (b.height ?? 120) - a.width * (a.height ?? 120))
    .slice(0, MAX_NODES);
  const kept = new Set(pick.map((n) => n.id));

  const built = pick.map((n) => ({
    id: n.id,
    box: {
      x: offX + ((n.x - minX) / spanX) * boxW,
      y: offY + ((n.y - minY) / spanY) * boxH,
      w: Math.max((n.width / spanX) * boxW, 6),
      h: Math.max(((n.height ?? 120) / spanY) * boxH, 5),
      kind: n.type,
      tone: toneOf(n),
      text: labels.get(n.id) ?? "",
    } as MiniNode,
  }));
  const center = new Map(built.map((entry) => [entry.id, entry.box]));
  // Small chips are painted first so a big chip never hides a small one.
  const mini = built
    .map((entry) => entry.box)
    .sort((a, b) => a.w * a.h - b.w * b.h);

  const edges: MiniEdge[] = [];
  for (const edge of data.edges ?? []) {
    if (!kept.has(edge.from) || !kept.has(edge.to)) continue;
    const from = center.get(edge.from);
    const to = center.get(edge.to);
    if (!from || !to) continue;
    edges.push({
      x1: from.x + from.w / 2,
      y1: from.y + from.h / 2,
      x2: to.x + to.w / 2,
      y2: to.y + to.h / 2,
    });
    if (edges.length >= 24) break;
  }

  return { nodes: mini, edges };
}

function stamp(time: number): string {
  const d = new Date(time);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
  return `${day} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function isBoardPath(path: string, folder?: string): boolean {
  if (!path.toLowerCase().endsWith(`.${BOARD_EXTENSION}`)) return false;
  if (!folder) return true;
  const prefix = folder.replace(/^\/+|\/+$/g, "");
  return !prefix || path.startsWith(`${prefix}/`);
}

export async function listBoardItems(app: App, folder: string): Promise<BoardItem[]> {
  const files = app.vault
    .getFiles()
    .filter((file) => isBoardPath(file.path, folder))
    .sort((a, b) => b.stat.mtime - a.stat.mtime);

  const items: BoardItem[] = [];
  for (const file of files) {
    let nodes = 0;
    let edges = 0;
    let cover: BoardItem["cover"] = { nodes: [], edges: [] };
    try {
      const data = JSON.parse(await app.vault.read(file)) as BoardData;
      nodes = Array.isArray(data.nodes) ? data.nodes.length : 0;
      edges = Array.isArray(data.edges) ? data.edges.length : 0;

      const labels = new Map<string, string>();
      let cards = 0;
      for (const node of data.nodes ?? []) {
        if (node.type === "card") {
          cards += 1;
          labels.set(node.id, cards <= MAX_CARDS ? await blockText(app, node) : "");
        } else {
          labels.set(node.id, labelOf(node, ""));
        }
      }
      cover = layout(data, labels);
    } catch {
      nodes = 0;
    }
    items.push({
      file,
      title: file.basename,
      nodes,
      edges,
      updated: stamp(file.stat.mtime),
      mtime: file.stat.mtime,
      created: file.stat.ctime,
      cover,
    });
  }
  return items;
}

/** New boards keep Obsidian's own naming (`未命名`, `未命名 1`, …). The file
 *  tree is the place people read names, so nothing here invents a format that
 *  would be truncated there. */
export async function createBoardItem(app: App, folder: string): Promise<TFile> {
  const path = await nextBoardPath(app, folder);
  return app.vault.create(path, JSON.stringify(blankBoardData(), null, 2));
}

/** Cheap identity for the current list, used to skip pointless redraws. */
export function listSignature(items: BoardItem[], sort: string): string {
  return [
    sort,
    ...items.map((item) => `${item.file.path}:${item.mtime}:${item.nodes}:${item.edges}`),
  ].join("|");
}

export function isBoardFile(file: TAbstractFile): file is TFile {
  return file instanceof TFileClass && file.extension.toLowerCase() === BOARD_EXTENSION;
}
