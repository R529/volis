import { App } from "obsidian";
import { listCardsInFile, readCard } from "../store/cardStore";
import { resolveCardFolder } from "./cardWriter";

export interface InsertItem {
  kind: "text" | "note" | "card";
  title: string;
  sub: string;
  file?: string;
  blockId?: string;
}

const MAX_RESULTS = 18;

/**
 * One list for everything that can be dropped onto a board: a fresh text node,
 * a fresh note, an existing card or an existing note.
 */
export async function searchInsertItems(
  app: App,
  cardFolderSetting: string,
  query: string
): Promise<InsertItem[]> {
  const q = query.trim().toLowerCase();

  if (!q) {
    return [
      { kind: "text", title: "新建文本节点", sub: "在白板上直接写" },
      { kind: "note", title: "新建空白笔记", sub: "生成一个 md 文件" },
    ];
  }

  const out: InsertItem[] = [];
  const cardFolder = await resolveCardFolder(app, cardFolderSetting);
  const allFiles = app.vault.getMarkdownFiles();
  const isCardFile = (path: string) => !cardFolder || path.startsWith(`${cardFolder}/`);

  for (const file of allFiles.filter((item) => isCardFile(item.path))) {
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

  for (const file of allFiles) {
    if (isCardFile(file.path)) continue;
    if (!file.basename.toLowerCase().includes(q)) continue;

    out.push({ kind: "note", title: file.basename, sub: "笔记", file: file.path });
    if (out.length >= MAX_RESULTS) break;
  }

  return out;
}
