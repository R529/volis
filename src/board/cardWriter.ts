import { App, TFile } from "obsidian";
import { readCard } from "../store/cardStore";

const DATE_HEADING = /^##[ \t]+(\d{4}-\d{2}-\d{2})[ \t]*$/;
// readCard hands back the block body with the list marker stripped, so the
// check is against the time prefix only, never against "- ".
const CARD_BODY_LINE = /^(\d{1,2}:\d{2})[ \t]+/;

export interface AppendResult {
  file: string;
  blockId: string;
}

/**
 * Resolve where Collis keeps its cards. We only read its config, never write it,
 * and fall back gracefully when the plugin is absent.
 */
export async function resolveCardFolder(app: App, fallback: string): Promise<string> {
  const adapter = app.vault.adapter;
  const configPath = ".obsidian/plugins/collis/data.json";

  try {
    if (await adapter.exists(configPath)) {
      const raw = JSON.parse(await adapter.read(configPath)) as { folderPath?: unknown };
      if (typeof raw.folderPath === "string" && raw.folderPath.trim()) {
        return raw.folderPath.trim().replace(/^\/+|\/+$/g, "");
      }
    }
  } catch (error) {
    // ignore: fall through to the configured folder
  }

  return (fallback || "00-Inbox/速记").replace(/^\/+|\/+$/g, "");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function uniqueBlockId(lines: string[]): string {
  const used = new Set<string>();
  const re = /\^([A-Za-z0-9-]+)/g;
  const text = lines.join("\n");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) used.add(match[1]);

  for (let i = 0; i < 60; i++) {
    const id = Math.random().toString(36).slice(2, 8);
    if (id.length >= 6 && !used.has(id)) return id;
  }
  return Date.now().toString(36);
}

function buildCardLines(content: string, time: string, blockId: string): string[] {
  const bodyLines = content
    .replace(/\r\n/g, "\n")
    .replace(/\n+$/, "")
    .split("\n");

  const out = bodyLines.map((line, index) =>
    index === 0 ? `- ${time} ${line}`.replace(/[ \t]+$/, "") : `  ${line}`.replace(/[ \t]+$/, "")
  );

  const last = out.length - 1;
  out[last] = `${out[last]} ^${blockId}`;
  return out;
}

function insertIntoDateSection(lines: string[], date: string, cardLines: string[]): string[] {
  const out = lines.slice();

  let start = -1;
  let end = -1;

  for (let i = 0; i < out.length; i++) {
    const match = out[i].match(DATE_HEADING);
    if (match && match[1] === date) {
      start = i;
      for (let j = i + 1; j < out.length; j++) {
        if (DATE_HEADING.test(out[j])) {
          end = j;
          break;
        }
      }
      if (end === -1) end = out.length;
      break;
    }
  }

  if (start !== -1) {
    let insertAt = end;
    while (insertAt > start + 1 && out[insertAt - 1].trim() === "") insertAt -= 1;

    out.splice(insertAt, 0, ...cardLines);

    const after = insertAt + cardLines.length;
    if (after < out.length && out[after].trim() !== "") {
      out.splice(after, 0, "");
    }
    return out;
  }

  // No section for this date yet: insert in chronological order.
  let insertAt = out.length;
  for (let i = 0; i < out.length; i++) {
    const match = out[i].match(DATE_HEADING);
    if (match && match[1] > date) {
      insertAt = i;
      break;
    }
  }

  const block: string[] = [];
  if (insertAt > 0 && out[insertAt - 1].trim() !== "") block.push("");
  block.push(`## ${date}`, "", ...cardLines);
  if (insertAt < out.length) block.push("");

  out.splice(insertAt, 0, ...block);
  return out;
}

/**
 * Append a card to the Collis month file using exactly the same conventions the
 * plugin writes: `- HH:mm content ^id`, two-space continuation, id on the last
 * line. The result is read back through the same parser Collis uses, so a bad
 * write fails loudly instead of leaving an orphan block.
 */
export async function appendCard(
  app: App,
  folder: string,
  content: string
): Promise<AppendResult | null> {
  const text = content.replace(/\r\n/g, "\n").trim();
  if (!text) return null;

  const now = new Date();
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const monthPath = `${folder}/${now.getFullYear()}-${pad(now.getMonth() + 1)}.md`;

  try {
    if (folder && !(await app.vault.adapter.exists(folder))) {
      await app.vault.createFolder(folder).catch(() => undefined);
    }

    let file = app.vault.getAbstractFileByPath(monthPath) as TFile | null;
    if (!file) {
      const blockId = uniqueBlockId([]);
      const cardLines = buildCardLines(text, time, blockId);
      const heading = `## ${date}\n\n${cardLines.join("\n")}\n`;
      file = await app.vault.create(monthPath, heading);

      const meta = await readCard(app, { file: monthPath, blockId, linkpath: "" });
      if (meta.stale) return null;
      return { file: monthPath, blockId };
    }

    const original = await app.vault.read(file);
    const lines = original.split("\n");
    const blockId = uniqueBlockId(lines);
    const cardLines = buildCardLines(text, time, blockId);

    const next = insertIntoDateSection(lines, date, cardLines).join("\n");
    await app.vault.modify(file, next);

    const meta = await readCard(app, { file: monthPath, blockId, linkpath: "" });
    if (meta.stale) return null;

    const firstLine = meta.body.split("\n")[0] ?? "";
    if (!CARD_BODY_LINE.test(firstLine)) return null;

    return { file: monthPath, blockId };
  } catch (error) {
    console.error("[Volis] append card failed", error);
    return null;
  }
}

export async function createNoteFromText(
  app: App,
  folder: string,
  content: string,
  title = "未命名"
): Promise<TFile | null> {
  const dir = folder.replace(/^\/+|\/+$/g, "");
  const base = title.trim() || "未命名";

  try {
    if (dir && !(await app.vault.adapter.exists(dir))) {
      await app.vault.createFolder(dir).catch(() => undefined);
    }

    // Upgrade in place when this path already holds a note generated by an
    // older build (plain "来源：" line instead of frontmatter).
    const firstPath = dir ? `${dir}/${base}.md` : `${base}.md`;
    const existing = app.vault.getAbstractFileByPath(firstPath);
    if (existing instanceof TFile) {
      const head = (await app.vault.read(existing)).slice(0, 32);
      if (head.startsWith("来源：")) {
        await app.vault.modify(existing, content);
        return existing;
      }
    }

    let index = existing ? 1 : 0;
    let path = "";
    do {
      const name = index === 0 ? `${base}.md` : `${base} ${index}.md`;
      path = dir ? `${dir}/${name}` : name;
      index += 1;
    } while (await app.vault.adapter.exists(path));

    return await app.vault.create(path, content);
  } catch (error) {
    console.error("[Volis] create note failed", error);
    return null;
  }
}
