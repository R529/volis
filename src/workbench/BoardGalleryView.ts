/** The board wall: one view, one way to look at the boards in one folder.
 *  Every open goes through Obsidian's native tab system. No side rail, no
 *  module registry, no developer-facing controls.
 *
 *  Deliberately built on plain DOM APIs only. Earlier revisions leaned on
 *  Obsidian's DOM helpers (`empty()`, `append()`), which fail silently in some
 *  runtime paths and left the tab blank; this version cannot fail that way and
 *  surfaces any real error on screen instead of swallowing it. */

import { ItemView, Menu, Modal, Notice, WorkspaceLeaf } from "obsidian";
import type { App, TFile } from "obsidian";
import type VolisPlugin from "../main";
import { isBoardPath, listBoardItems, listSignature } from "./boardGalleryData";
import type { BoardItem, MiniEdge, MiniNode } from "./types";

export const VIEW_TYPE_WORKBENCH = "volis-workbench";

const SVG_NS = "http://www.w3.org/2000/svg";

const ICON = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="10.5" cy="10.5" r="6.2"/><path d="m15.2 15.2 4.3 4.3"/></svg>',
  sort: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 6h9M4 12h6M4 18h4M17 5v13m0 0-3-3m3 3 3-3"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m7 10 5 5 5-5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
  /* Same geometry as the ribbon icon painted in main.ts. */
  volis: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3.5" width="19" height="17" rx="5" stroke-dasharray="3 2.6"/><path d="M6 15.5C8.2 10.5 11 10.2 11.8 12.4C12.6 14.6 15.4 14.8 17.6 10.2"/><circle cx="18.6" cy="6.6" r="1.5" fill="currentColor" stroke="none"/></svg>',
  board: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="8" height="7" rx="1.6"/><rect x="13" y="4" width="8" height="4" rx="1.6"/><rect x="13" y="10" width="8" height="10" rx="1.6"/><rect x="3" y="13" width="8" height="7" rx="1.6"/></svg>',
  node: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4" y="4" width="16" height="12" rx="2.4"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h16M9 7V4.8h6V7M6.5 7l.8 12.2h9.4L17.5 7"/><path d="M10 10.5v5.5M14 10.5v5.5"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4.5 4.5L19 7"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M9.5 14.5 14.5 9.5"/><path d="M8 12 6.6 13.4a3.4 3.4 0 0 0 4.8 4.8L13 16.6"/><path d="M16 12l1.4-1.4a3.4 3.4 0 0 0-4.8-4.8L11 7.4"/></svg>',
};

export class BoardGalleryView extends ItemView {
  private readonly plugin: VolisPlugin;
  private items: BoardItem[] = [];
  private sortMode: "created" | "modified" | "name" = "created";
  private query = "";
  private multi = false;
  private selected = new Set<string>();
  /** Repaint bookkeeping: the wall listens to the vault, so it redraws while
   *  hidden. Only a real change is worth touching the DOM. */
  private signature = "";
  private reloadTimer: number | null = null;
  private watching = false;

  constructor(leaf: WorkspaceLeaf, plugin: VolisPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_WORKBENCH; }
  getDisplayText(): string { return "画布集"; }
  getIcon(): string { return "layout-grid"; }

  async onOpen(): Promise<void> {
    // Draw the shell first: the tab must never be blank, even if reading the
    // folder throws.
    try {
      this.renderWall();
    } catch (error) {
      this.reportError("绘制界面", error);
      return;
    }

    try {
      await this.loadItems();
    } catch (error) {
      this.reportError("读取画布", error);
    }
    this.watchSources();
  }

  async onClose(): Promise<void> {
    if (this.reloadTimer !== null) {
      window.clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    const root = this.rootEl();
    if (root) this.clearRoot(root);
  }

  refreshWall(): void {
    void this.loadItems();
  }

  /** The wall is a live mirror of the folder: a board saved in another tab, a
   *  file added in the tree or the tab coming back to front all repaint it.
   *  This is why nothing here needs a refresh button. */
  private watchSources(): void {
    if (this.watching) return;
    this.watching = true;
    const inFolder = (path: string) => isBoardPath(path, this.plugin.workbenchFolder);

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (inFolder(file.path)) this.schedule(220);
      }),
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (inFolder(file.path)) this.schedule(60);
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (inFolder(file.path)) this.schedule(60);
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (inFolder(file.path) || inFolder(oldPath)) this.schedule(60);
      }),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        // Coming back from a board: repaint even if the save event was missed.
        if (leaf === this.leaf) this.schedule(0);
      }),
    );
  }

  private schedule(delay: number): void {
    if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
    this.reloadTimer = window.setTimeout(() => {
      this.reloadTimer = null;
      void this.loadItems();
    }, delay);
  }

  /** The element the wall is drawn into. `contentEl` is normally present, but
   *  fall back to the view container rather than touching a null reference. */
  private rootEl(): HTMLElement | null {
    const content = this.contentEl as HTMLElement | undefined;
    if (content) return content;
    const child = this.containerEl?.children?.[1] as HTMLElement | undefined;
    if (child) return child;
    return this.containerEl ?? null;
  }

  private clearRoot(el: HTMLElement): void {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  private reportError(stage: string, error: unknown): void {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`[volis] 画布集${stage}失败`, error);
    const root = this.rootEl();
    if (root) {
      this.clearRoot(root);
      const box = document.createElement("div");
      box.className = "vw-error";
      const title = document.createElement("strong");
      title.textContent = `画布集${stage}失败`;
      const detail = document.createElement("p");
      detail.textContent = message;
      box.appendChild(title);
      box.appendChild(detail);
      root.appendChild(box);
    }
    new Notice(`画布集${stage}失败：${message}`);
  }

  private async loadItems(): Promise<void> {
    let items: BoardItem[] = [];
    try {
      items = await listBoardItems(this.app, this.plugin.workbenchFolder);
    } catch {
      new Notice("读取画布列表失败");
    }
    items = [...items].sort((a, b) => {
      if (this.sortMode === "name") return a.title.localeCompare(b.title, "zh-CN");
      if (this.sortMode === "modified") return b.mtime - a.mtime;
      return b.created - a.created;
    });
    this.items = items;
    if (listSignature(items, this.sortMode) === this.signature) return;
    this.renderWall();
  }

  private renderWall(): void {
    const root = this.rootEl();
    if (!root) return;
    const scrolled = root.querySelector(".vw-scroll") as HTMLElement | null;
    const scroll = scrolled ? scrolled.scrollTop : 0;
    this.clearRoot(root);
    root.classList.add("wb-root");

    // One bordered layer around the whole page, header included; the cards
    // scroll inside it so the frame stays put.
    const frame = node("div", "vw-frame");
    const toolbar = node("div", "vw-toolbar");
    toolbar.appendChild(this.buildHead());
    frame.appendChild(toolbar);

    const body = node("div", "vw-scroll");
    const results = node("div", "vw-results");
    results.appendChild(this.buildResults());
    body.appendChild(results);
    frame.appendChild(body);
    root.appendChild(frame);
    body.scrollTop = scroll;
    this.signature = listSignature(this.items, this.sortMode);
  }

  /** Typing only swaps the results: the input keeps focus and caret. */
  private updateResults(): void {
    const root = this.rootEl();
    if (!root) return;
    const results = root.querySelector(".vw-results") as HTMLElement | null;
    const count = root.querySelector(".vw-count");
    if (!results) return;
    this.clearRoot(results);
    results.appendChild(this.buildResults());
    const visible = this.visibleItems();
    if (count) {
      count.textContent = this.query
        ? `${visible.length} / ${this.items.length} 块`
        : `${this.items.length} 块`;
    }
  }

  private visibleItems(): BoardItem[] {
    const q = this.query.trim().toLocaleLowerCase();
    if (!q) return this.items;
    return this.items.filter((item) =>
      [item.title, ...item.cover.nodes.map((box) => box.text)]
        .some((text) => text.toLocaleLowerCase().includes(q)),
    );
  }

  private buildResults(): HTMLElement {
    const visible = this.visibleItems();
    if (!visible.length) {
      return this.buildEmpty(this.query.trim().length > 0);
    }
    const grid = node("div", "vw-grid");
    for (const item of visible) grid.appendChild(this.buildCard(item));
    return grid;
  }

  private buildEmpty(searching: boolean): HTMLElement {
    const empty = node("div", "vw-empty");
    const art = node("div", "vw-empty-art");
    // Same mark as the ribbon icon and the blank cover, so the empty wall
    // reads as part of this plugin rather than a generic board glyph.
    art.innerHTML = ICON.volis;
    const title = node("div", "vw-empty-title");
    title.textContent = searching ? "没有匹配的画布" : "还没有画布";
    const hint = document.createElement("p");
    hint.className = "vw-empty-hint";
    hint.textContent = searching
      ? "换个关键词试试，搜索范围包括画布名称和画布上的文字。"
      : "新建的画布会存进「画布」文件夹，和文件树完全同步。";

    const button = document.createElement("button");
    button.className = "vw-primary is-large";
    if (searching) {
      const label = document.createElement("span");
      label.textContent = "清除搜索";
      button.appendChild(label);
      button.addEventListener("click", () => {
        this.query = "";
        this.renderWall();
        const input = this.rootEl()?.querySelector(".vw-search-input") as HTMLInputElement | null;
        if (input) input.focus();
      });
    } else {
      const plus = node("span", "vw-ico");
      plus.innerHTML = ICON.plus;
      const label = document.createElement("span");
      label.textContent = "新建第一块画布";
      button.appendChild(plus);
      button.appendChild(label);
      button.addEventListener("click", () => { void this.createBoard(); });
    }

    empty.appendChild(art);
    empty.appendChild(title);
    empty.appendChild(hint);
    empty.appendChild(button);
    return empty;
  }

  private buildHead(): HTMLElement {
    const head = node("div", "vw-head");

    const intro = node("div", "vw-intro");
    const title = node("div", "vw-title");
    const h1 = document.createElement("h1");
    h1.textContent = "画布集";
    const count = node("span", "vw-count");
    const visible = this.visibleItems();
    count.textContent = this.query
      ? `${visible.length} / ${this.items.length} 块`
      : `${this.items.length} 块`;
    title.appendChild(h1);
    title.appendChild(count);
    intro.appendChild(title);
    head.appendChild(intro);

    const actions = node("div", "vw-actions");
    if (this.multi) {
      const info = node("span", "vw-multi-count");
      info.textContent = `已选 ${this.selected.size} 块`;
      actions.appendChild(info);

      actions.appendChild(simpleButton("全选", "vw-ghost", () => {
        for (const item of this.visibleItems()) this.selected.add(item.file.path);
        this.syncSelectionUI();
      }));
      const remove = simpleButton("删除所选", "vw-primary vw-danger", () => {
        const chosen = this.items.filter((item) => this.selected.has(item.file.path));
        // A batch delete ends the selection session: once the boards are gone
        // the user must click 多选 again to pick another batch.
        this.confirmDelete(chosen, true);
      });
      if (!this.selected.size) (remove as HTMLButtonElement).disabled = true;
      actions.appendChild(remove);
      actions.appendChild(simpleButton("退出多选", "vw-ghost", () => this.setMulti(false)));
      head.appendChild(actions);
      return head;
    }

    const search = node("div", "vw-search");
    const glass = node("span", "vw-ico");
    glass.innerHTML = ICON.search;
    const input = document.createElement("input");
    input.type = "search";
    input.className = "vw-search-input";
    input.placeholder = "搜索画布";
    // Obsidian styles every input with its own border/focus ring and shows an
    // aria-label tooltip. One inline reset beats all of those rules: the field
    // is simply the text area inside the one search box.
    input.style.cssText =
      "all: unset !important; display: block !important; width: 116px !important;" +
      "padding: 0 !important; border: 0 !important; box-shadow: none !important;" +
      "outline: none !important; background: transparent !important;" +
      "font: inherit !important; font-size: 12px !important; line-height: 1.3 !important;" +
      "color: var(--text-normal) !important; cursor: text !important;";
    input.value = this.query;
    input.addEventListener("input", () => {
      this.query = input.value;
      this.updateResults();
    });
    search.appendChild(glass);
    search.appendChild(input);
    actions.appendChild(search);

    const create = document.createElement("button");
    create.className = "vw-primary";
    const plus = node("span", "vw-ico");
    plus.innerHTML = ICON.plus;
    const createLabel = document.createElement("span");
    createLabel.textContent = "新建画布";
    create.appendChild(plus);
    create.appendChild(createLabel);
    create.addEventListener("click", () => { void this.createBoard(); });
    actions.appendChild(create);

    const more = node("button", "vw-sort vw-more");
    more.setAttribute("title", "更多操作");
    const moreIcon = node("span", "vw-ico");
    moreIcon.innerHTML = ICON.more;
    more.appendChild(moreIcon);
    more.addEventListener("click", (event) => this.showMoreMenu(event));
    actions.appendChild(more);

    head.appendChild(actions);
    return head;
  }

  /** The single "..." control holds sorting and multi-select, like the menu
   *  at the top of Obsidian's file tree. */
  private showMoreMenu(event: MouseEvent): void {
    const menu = new Menu();
    const options: Array<["created" | "modified" | "name", string]> = [
      ["created", "按创建时间"],
      ["modified", "按修改时间"],
      ["name", "按名称"],
    ];
    for (const [value, label] of options) {
      menu.addItem((item) =>
        item
          .setTitle(label)
          .setChecked(this.sortMode === value)
          .onClick(() => this.setSort(value)),
      );
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(this.multi ? "退出多选" : "多选")
        .setChecked(this.multi)
        .onClick(() => this.setMulti(!this.multi)),
    );
    // Anchor to the button itself, not the mouse cursor: showAtMouseEvent()
    // puts the menu wherever the click happened, which drifts to the right.
    const anchor = (event.currentTarget ?? event.target) as HTMLElement | null;
    const rect = anchor?.getBoundingClientRect?.();
    if (rect) menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
    else menu.showAtMouseEvent(event);
  }

  private setSort(value: "created" | "modified" | "name"): void {
    if (this.sortMode === value) return;
    this.sortMode = value;
    void this.loadItems();
  }

  private buildCard(item: BoardItem): HTMLElement {
    const card = node("div", "vw-card");
    card.setAttribute("data-path", item.file.path);
    if (this.multi && this.selected.has(item.file.path)) card.classList.add("is-selected");
    card.appendChild(this.buildCover(item));

    if (this.multi) {
      const check = node("span", "vw-check");
      check.innerHTML = ICON.check;
      card.appendChild(check);
    }

    const del = document.createElement("button");
    del.className = "vw-card-del";
    del.setAttribute("title", "删除画布");
    del.innerHTML = ICON.trash;
    del.addEventListener("click", (event) => {
      event.stopPropagation();
      this.confirmDelete([item]);
    });
    card.appendChild(del);

    const body = node("div", "vw-card-body");
    const head = node("div", "vw-card-head");
    const icon = node("span", "vw-card-icon");
    icon.innerHTML = ICON.board;
    const title = node("div", "vw-card-title");
    title.textContent = item.title;
    head.appendChild(icon);
    head.appendChild(title);
    body.appendChild(head);

    const date = node("div", "vw-card-date");
    date.textContent = item.updated;
    body.appendChild(date);

    const props = node("div", "vw-card-props");
    props.appendChild(prop(ICON.node, item.nodes ? `${item.nodes} 个节点` : "空白画布"));
    if (item.edges) props.appendChild(prop(ICON.link, `${item.edges} 条连线`));
    body.appendChild(props);

    card.appendChild(body);
    card.addEventListener("click", () => {
      if (this.multi) this.toggleSelected(item.file.path);
      else this.openBoard(item);
    });
    return card;
  }

  /** The cover is a true miniature of the board: same layout, same colours,
   *  and the real text of its nodes, so a card can be recognised without
   *  opening it. */
  private buildCover(item: BoardItem): HTMLElement {
    const cover = node("div", "vw-cover");
    const { nodes, edges } = item.cover;

    if (!nodes.length) {
      cover.classList.add("is-blank");
      const ghost = node("span", "vw-cover-ghost");
      ghost.innerHTML = ICON.volis;
      cover.appendChild(ghost);
      return cover;
    }

    if (edges.length) cover.appendChild(edgeLayer(edges));

    for (const box of nodes) {
      const chip = node("span", "vw-chip");
      applyBox(chip, box);
      applyTone(chip, box.tone);
      chip.setAttribute("data-kind", box.kind);
      if (box.text && box.w >= 15 && box.h >= 13) {
        const text = node("span", "vw-chip-text");
        text.textContent = box.text;
        chip.appendChild(text);
      }
      cover.appendChild(chip);
    }
    return cover;
  }

  private openBoard(item: BoardItem): void {
    void this.plugin.openBoardFile(item.file.path);
  }

  private setMulti(on: boolean): void {
    this.multi = on;
    if (!on) this.selected.clear();
    this.renderWall();
  }

  private toggleSelected(path: string): void {
    if (this.selected.has(path)) this.selected.delete(path);
    else this.selected.add(path);
    this.syncSelectionUI();
  }

  /** Selecting a card touches only the affected attributes. Rebuilding the
   *  whole wall here made the card flash and swallowed the next click. */
  private syncSelectionUI(): void {
    const root = this.rootEl();
    if (!root) return;
    for (const card of Array.from(root.querySelectorAll("[data-path]"))) {
      const path = card.getAttribute("data-path") ?? "";
      card.classList.toggle("is-selected", this.selected.has(path));
    }
    const count = root.querySelector(".vw-multi-count");
    if (count) count.textContent = `已选 ${this.selected.size} 块`;
    const remove = root.querySelector(".vw-danger") as HTMLButtonElement | null;
    if (remove) remove.disabled = this.selected.size === 0;
  }

  private confirmDelete(items: BoardItem[], exitMulti = false): void {
    if (!items.length) return;
    new DeleteBoardsModal(this.app, items.map((item) => item.title), () => {
      void this.deleteBoards(items.map((item) => item.file), exitMulti);
    }).open();
  }

  private async deleteBoards(files: TFile[], exitMulti = false): Promise<void> {
    let removed = 0;
    for (const file of files) {
      try {
        await this.app.fileManager.trashFile(file);
        removed += 1;
      } catch {
        try {
          await this.app.vault.delete(file);
          removed += 1;
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "删除画布失败");
        }
      }
    }
    for (const file of files) this.selected.delete(file.path);
    if (exitMulti && removed > 0) {
      // Leave multi-select right after a batch delete, then rebuild from the
      // fresh list so no card keeps its selected state.
      this.multi = false;
      this.selected.clear();
      this.signature = "";
    }
    await this.loadItems();
  }

  private async createBoard(): Promise<void> {
    try {
      await this.plugin.createGalleryBoard();
      await this.loadItems();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "新建画布失败");
    }
  }
}

function prop(icon: string, label: string): HTMLElement {
  const row = node("span", "vw-prop");
  const glyph = node("span", "vw-ico");
  glyph.innerHTML = icon;
  const text = document.createElement("span");
  text.textContent = label;
  row.appendChild(glyph);
  row.appendChild(text);
  return row;
}

function edgeLayer(edges: MiniEdge[]): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg") as SVGElement;
  svg.setAttribute("class", "vw-cover-lines");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");
  for (const edge of edges) {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(edge.x1));
    line.setAttribute("y1", String(edge.y1));
    line.setAttribute("x2", String(edge.x2));
    line.setAttribute("y2", String(edge.y2));
    svg.appendChild(line);
  }
  return svg;
}

function applyBox(el: HTMLElement, box: MiniNode): void {
  el.style.left = `${box.x}%`;
  el.style.top = `${box.y}%`;
  el.style.width = `${box.w}%`;
  el.style.height = `${box.h}%`;
}

function applyTone(el: HTMLElement, tone: string): void {
  if (!tone) return;
  if (tone.startsWith("#")) el.style.setProperty("--tn", tone);
  else el.setAttribute("data-tone", tone);
}

function node(tag: string, className: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  return el;
}

function simpleButton(label: string, className: string, onClick: () => void): HTMLElement {
  const button = document.createElement("button");
  button.className = className;
  const text = document.createElement("span");
  text.textContent = label;
  button.appendChild(text);
  button.addEventListener("click", onClick);
  return button;
}

/** Native confirmation before anything leaves the vault. */
class DeleteBoardsModal extends Modal {
  constructor(app: App, private names: string[], private onConfirm: () => void) {
    super(app);
  }

  onOpen(): void {
    const el = this.contentEl as HTMLElement;
    while (el.firstChild) el.removeChild(el.firstChild);
    el.classList.add("volis-delete-modal");
    const heading = document.createElement("h2");
    heading.textContent = this.names.length === 1 ? "删除这块画布？" : `删除这 ${this.names.length} 块画布？`;
    const detail = document.createElement("p");
    const shown = this.names.slice(0, 3).join("、");
    detail.textContent = this.names.length > 3
      ? `会移到系统回收站：${shown} 等 ${this.names.length} 块。`
      : `会移到系统回收站：${shown}。`;
    const row = node("div", "vw-modal-actions");
    const cancel = document.createElement("button");
    cancel.className = "vw-ghost";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => this.close());
    const confirm = document.createElement("button");
    confirm.className = "vw-primary vw-danger";
    confirm.textContent = "删除";
    confirm.addEventListener("click", () => {
      this.close();
      this.onConfirm();
    });
    row.appendChild(cancel);
    row.appendChild(confirm);
    el.appendChild(heading);
    el.appendChild(detail);
    el.appendChild(row);
  }

  onClose(): void {
    const el = this.contentEl as HTMLElement;
    while (el.firstChild) el.removeChild(el.firstChild);
  }
}
