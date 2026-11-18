import { App, TFile } from "obsidian";
import { BoardData } from "./types";

export const BOARD_EXTENSION = "volis";

/** Content for a brand-new board. Never carry old nodes over implicitly:
 *  "new board" must mean blank, and any legacy file stays untouched on disk. */
export function blankBoardData(): BoardData {
  return { version: 1, nodes: [], edges: [] };
}

export async function saveBoardFile(app: App, path: string, data: BoardData): Promise<void> {
  try {
    const adapter = app.vault.adapter;
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (folder && !(await adapter.exists(folder))) {
      await app.vault.createFolder(folder).catch(() => undefined);
    }
    await adapter.write(path, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("[Volis] save board failed", error);
  }
}

export async function nextBoardPath(app: App, folder: string): Promise<string> {
  const dir = folder.replace(/^\/+|\/+$/g, "");
  const adapter = app.vault.adapter;
  const base = "未命名";

  let name = `${base}.${BOARD_EXTENSION}`;
  let index = 1;
  let path = dir ? `${dir}/${name}` : name;

  while (await adapter.exists(path)) {
    name = `${base} ${index}.${BOARD_EXTENSION}`;
    path = dir ? `${dir}/${name}` : name;
    index += 1;
  }

  return path;
}

export function listBoards(app: App): TFile[] {
  return app.vault
    .getFiles()
    .filter((file) => file.extension.toLowerCase() === BOARD_EXTENSION)
    .sort((a, b) => b.stat.mtime - a.stat.mtime);
}
