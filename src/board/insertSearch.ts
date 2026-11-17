import { App, TFile } from "obsidian";
import { listCardsInFile, readCard } from "../store/cardStore";
import { resolveCardFolder } from "./cardWriter";

export type InsertKind = "text" | "note" | "card" | "media";

export interface InsertItem {
  kind: InsertKind;
  title: string;
  sub: string;
  file?: string;
  blockId?: string;
}

export type InsertFilter = "note" | "card" | "media";

const MEDIA_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif",
  "mp4", "webm", "mov", "mkv",
  "mp3", "wav", "ogg", "m4a", "flac",
  "pdf",
]);

const MAX_RESULTS = 40;

/**
 * One list for everything that can be dropped onto a board: a fresh text node,
 * a fresh note, an existing card, an existing note or a media file.
 *
 * Each picker gets a different source list: notes/cards come from markdown
 * files, media comes from ALL files in the vault (getMarkdownFiles() would
 * never return a single image or video).
 */
export async function searchInsertItems(
  app: App,
  cardFolderSetting: string,
  query: string,
  filter?: InsertFilter
): Promise<InsertItem[]> {
  const q = query.trim().toLowerCase();

  // No query and no filter is the generic insert picker: offer the two
  // "create new" actions instead of dumping every note on the user.
  if (!q && !filter) {
    return [
      { kind: "text", title: "新建文本节点", sub: "在白板上直接写" },
      { kind: "note", title: "新建空白笔记", sub: "生成一个 md 文件" },
    ];
  }

  const out: InsertItem[] = [];

  // --- Media picker -------------------------------------------------------
  // This branch returns early because its source list is completely different
  // from the note/card one, and should never be mixed with them.
  if (filter === "media") {
    for (const file of app.vault.getFiles()) {
      if (!(file instanceof TFile)) continue;
      if (!MEDIA_EXT.has(file.extension.toLowerCase())) continue;
      if (q && !file.path.toLowerCase().includes(q)) continue;

      out.push({
        kind: "media",
        // Full vault-relative path, matching Obsidian's own file picker.
        title: file.path,
        sub: "",
        file: file.path,
      });

      if (out.length >= MAX_RESULTS) break;
    }

    return out;
  }

  // --- Notes and cards ----------------------------------------------------
  const cardFolder = await resolveCardFolder(app, cardFolderSetting);
  const markdownFiles = app.vault.getMarkdownFiles();
  const isCardFile = (path: string) => !cardFolder || path.startsWith(`${cardFolder}/`);

  if (filter !== "note") {
    for (const file of markdownFiles.filter((item) => isCardFile(item.path))) {
      const refs = await listCardsInFile(app, file.path);

      for (const ref of refs) {
        const meta = await readCard(app, ref);
        if (meta.stale) continue;

        const text = meta.editable;
        if (!text.toLowerCase().includes(q)) continue;

        const preview = text.replace(/\s+/g, " ").slice(0, 60);
        const tags = meta.tags.length > 0 ? ` · #${meta.tags[0]}` : "";
        out.push({
          kind: "card",
          title: preview,
          sub: `卡片 · ${meta.date ?? ""} ${meta.time ?? ""}${tags}`,
          file: ref.file,
          blockId: ref.blockId,
        });

        if (out.length >= MAX_RESULTS) return out;
      }
    }
  }

  if (filter !== "card") {
    for (const file of markdownFiles) {
      if (isCardFile(file.path)) continue;
      if (!file.basename.toLowerCase().includes(q)) continue;

      out.push({ kind: "note", title: file.basename, sub: "笔记", file: file.path });
      if (out.length >= MAX_RESULTS) break;
    }
  }

  return out;
}
