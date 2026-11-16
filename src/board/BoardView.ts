import { MarkdownRenderer, Menu, Notice, TFile, TextFileView, WorkspaceLeaf, setIcon } from "obsidian";
import type VolisPlugin from "../main";
import { readCard, writeCard } from "../store/cardStore";
import { InlineEditor } from "../ui/inlineEditor";
import { MarkdownNodeEditor } from "../ui/markdownNodeEditor";
import { MediaModal } from "../ui/mediaModal";
import { RenameModal } from "../ui/renameModal";
import { appendCard, createNoteFromText, resolveCardFolder } from "./cardWriter";
import { InsertItem, searchInsertItems } from "./insertSearch";
import {
  BoardData,
  BoardEdge,
  BoardNode,
  PortSide,
  CardNode,
  DEFAULT_CARD_WIDTH,
  DEFAULT_FILE_WIDTH,
  FileNode,
  GroupNode,
  TextNode,
} from "./types";

export const VIEW_TYPE_VOLIS_BOARD = "volis-board";

const GRID = 24;
const MIN_GRID = 10;
const MIN_SCALE = 0.05;
const MAX_SCALE = 3;
const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];
const VIDEO_EXT = ["mp4", "webm", "mov", "mkv"];

const NODE_COLORS = [
  { name: "red", label: "红", line: "#d9534f", bg: "#f8dedd" },
  { name: "orange", label: "橙", line: "#e08a2e", bg: "#faecd9" },
  { name: "yellow", label: "黄", line: "#c9a227", bg: "#f8f2d8" },
  { name: "green", label: "绿", line: "#639922", bg: "#e8f1d9" },
  { name: "teal", label: "青", line: "#1d9e75", bg: "#d9f0e7" },
  { name: "blue", label: "蓝", line: "#378add", bg: "#dfeafa" },
  { name: "purple", label: "紫", line: "#7f77dd", bg: "#e7e5f9" },
] as const;

interface NodeDrag {
  type: "node";
  pointerId: number;
  startWorld: { x: number; y: number };
  initial: Map<string, { x: number; y: number }>;
}

interface PanDrag {
  type: "pan";
  pointerId: number;
  startClient: { x: number; y: number };
  startView: { tx: number; ty: number };
}

interface BoxDrag {
  type: "box";
  pointerId: number;
}

type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

interface GuideLine {
  axis: "x" | "y";
  pos: number;
}

interface ResizeDrag {
  type: "resize";
  pointerId: number;
  nodeId: string;
  dir: ResizeDir;
  startX: number;
  startY: number;
  start: { x: number; y: number; width: number; height: number };
}

type Drag = NodeDrag | PanDrag | BoxDrag | ResizeDrag;

interface ToolbarAction {
  id: string;
  icon: string;
  label: string;
  danger?: boolean;
  visible?: (nodes: BoardNode[]) => boolean;
  enabled?: (nodes: BoardNode[]) => boolean;
  run: (nodes: BoardNode[], evt: MouseEvent) => void;
}

export class BoardView extends TextFileView {
  private root!: HTMLElement;
  private world!: HTMLElement;
  private zoomEl!: HTMLElement;
  private hintEl!: HTMLElement;

  private nodes: BoardNode[] = [];
  private edges: BoardEdge[] = [];
  private nodeMap = new Map<string, BoardNode>();
  private nodeEls = new Map<string, HTMLElement>();
  private selection = new Set<string>();

  private tx = 0;
  private ty = 0;
  private scale = 1;

  private drag: Drag | null = null;
  private boxEl: HTMLElement | null = null;
  private boxStart: { x: number; y: number } | null = null;
  private lastDownNodeId: string | null = null;
  private pendingNodeClick: { id: string; wasSelected: boolean; x: number; y: number } | null = null;
  private spaceDown = false;

  private saveTimer: number | null = null;
  private frameEl: HTMLElement | null = null;
  private edgesEl: SVGSVGElement | null = null;
  private minimapEl: HTMLElement | null = null;
  private minimapSvg: SVGSVGElement | null = null;
  private minimapDragging = false;
  private selectedEdgeId: string | null = null;
  private nodeText = new Map<string, string>();
  private searchPanel: HTMLElement | null = null;
  private searchOutside: ((evt: MouseEvent) => void) | null = null;
  private clipboard: BoardNode[] = [];
  private clipboardEdges: BoardEdge[] = [];
  private lastPointerWorld: { x: number; y: number } | null = null;
  private insertPanel: HTMLElement | null = null;
  private edgeBar: HTMLElement | null = null;
  private alignPop: HTMLElement | null = null;
  private alignOutside: ((evt: MouseEvent) => void) | null = null;
  private colorPop: HTMLElement | null = null;
  private colorOutside: ((evt: MouseEvent) => void) | null = null;
  private panelOutside: ((evt: MouseEvent) => void) | null = null;
  private linkDrag: {
    fromId: string;
    pointerId: number;
    path: SVGPathElement;
    anchor: { x: number; y: number };
    side: PortSide;
  } | null = null;
  private loaded = false;

  private history: string[] = [];
  private historyIndex = -1;
  private dragMoved = false;
  private toolbarEl!: HTMLElement;
  private toolbarKey = "";
  private rawFallback: string | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private lastSize = { w: 0, h: 0 };
  private moreBtn: HTMLButtonElement | null = null;
  private undoBtn: HTMLButtonElement | null = null;
  private redoBtn: HTMLButtonElement | null = null;
  private staleIds = new Set<string>();

  private static readonly HISTORY_LIMIT = 60;

  constructor(leaf: WorkspaceLeaf, private plugin: VolisPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_VOLIS_BOARD;
  }

  getDisplayText(): string {
    return this.file?.basename ?? "白板";
  }

  getViewData(): string {
    // A file we failed to parse must never be overwritten by an empty board.
    if (this.rawFallback !== null) return this.rawFallback;
    return JSON.stringify(this.serialize(), null, 2);
  }

  setViewData(data: string, _clear: boolean): void {
    // Do not wipe the DOM here: the base class calls clear() first and only
    // then hands us the content, which would leave one empty frame on screen.
    // `clear` is ignored on purpose: wiping the DOM here would flash an empty
    // canvas before the incoming content is ready.
    this.loadWhenLaidOut(data, 0);
  }

  private loadWhenLaidOut(data: string, attempt: number): void {
    if (!this.world) {
      if (attempt < 25) {
        window.setTimeout(() => this.loadWhenLaidOut(data, attempt + 1), 30);
      }
      return;
    }

    const rect = this.root.getBoundingClientRect();
    if (rect.width === 0 && attempt < 25) {
      window.setTimeout(() => this.loadWhenLaidOut(data, attempt + 1), 30);
      return;
    }

    void this.loadFromJson(data);
  }

  clear(): void {
    // Intentionally non-destructive; see setViewData above.
  }

  getIcon(): string {
    return "layout-dashboard";
  }

  async onOpen(): Promise<void> {
    this.buildUI();
    this.registerDomEvent(document, "keydown", this.onKeyDown);
    this.registerDomEvent(document, "keyup", this.onKeyUp);
    this.registerDomEvent(this.containerEl, "click", this.onHeaderTitleClick, {
      capture: true,
    });

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) void this.refreshNodesForFile(file.path, 80);
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) this.handleFileRename(file.path, oldPath);
      })
    );

    this.loaded = true;
  }

  /**
   * Every node pointing at this file mirrors the latest content, so the same
   * note can appear several times on one board (or across boards) and all of
   * them stay in sync.
   */
  private async refreshNodesForFile(path: string, delay = 0): Promise<void> {
    if (delay > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, delay));
    }

    const targets = this.nodes.filter(
      (node) => (node.type === "file" || node.type === "card") && node.file === path
    );
    for (const node of targets) {
      const el = this.nodeEls.get(node.id);
      if (el && el.hasClass("volis-editing")) continue;
      await this.renderNode(node);
    }
  }

  private handleFileRename(newPath: string, oldPath: string): void {
    let touched = false;
    for (const node of this.nodes) {
      if (node.type === "file" && node.file === oldPath) {
        node.file = newPath;
        touched = true;
        void this.renderNode(node);
      }
    }
    if (touched) this.scheduleSave();
  }

  async onClose(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
  }

  private handleResize(): void {
    const rect = this.root.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w === 0 || h === 0) return;

    if (this.lastSize.w === 0) {
      this.lastSize = { w, h };
      return;
    }

    const dw = w - this.lastSize.w;
    const dh = h - this.lastSize.h;
    this.lastSize = { w, h };

    if (dw === 0 && dh === 0) return;

    // Keep whatever was in the middle of the viewport in the middle.
    this.tx += dw / 2;
    this.ty += dh / 2;
    this.applyTransform();
  }

  private buildUI(): void {
    // Tag the whole leaf so CSS can target the header bar of this tab only.
    this.containerEl.addClass("volis-board-leaf");

    const container = this.contentEl;
    container.empty();
    container.addClass("volis-board-host");

    this.root = container.createDiv({ cls: "volis-board" });
    this.world = this.root.createDiv({ cls: "volis-world" });

    const toolbar = this.root.createDiv({ cls: "volis-board-toolbar" });
    toolbar.addEventListener("pointerdown", (evt) => evt.stopPropagation());
    toolbar.addEventListener("dblclick", (evt) => evt.stopPropagation());

    const addButton = (icon: string, label: string, handler: (evt: MouseEvent) => void) => {
      const button = toolbar.createEl("button", {
        cls: "volis-board-btn",
        attr: { "aria-label": label },
      });
      setIcon(button, icon);
      button.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        handler(evt);
      });
      return button;
    };

    this.moreBtn = addButton("more-vertical", "更多", (evt) => this.showBoardMenu(evt));
    toolbar.createDiv({ cls: "volis-board-sep" });
    addButton("plus", "放大", () => this.zoomBy(1.2));
    addButton("minus", "缩小", () => this.zoomBy(1 / 1.2));
    addButton("maximize", "总览", () => {
      this.fitToContent();
      this.scheduleSave();
    });
    toolbar.createDiv({ cls: "volis-board-sep" });
    this.undoBtn = addButton("undo-2", "撤销", () => void this.undo());
    this.redoBtn = addButton("redo-2", "重做", () => void this.redo());
    this.updateHistoryButtons();

    this.toolbarEl = this.root.createDiv({ cls: "volis-node-toolbar is-hidden" });
    this.toolbarEl.addEventListener("pointerdown", (evt) => evt.stopPropagation());
    this.toolbarEl.addEventListener("dblclick", (evt) => evt.stopPropagation());

    this.minimapEl = this.root.createDiv({ cls: "volis-minimap is-hidden" });

    const miniSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    miniSvg.classList.add("volis-minimap-svg");
    this.minimapEl.appendChild(miniSvg);
    this.minimapSvg = miniSvg;

    this.minimapEl.addEventListener("pointerdown", this.onMinimapDown);
    this.minimapEl.addEventListener("dblclick", (evt) => evt.stopPropagation());

    this.edgeBar = this.root.createDiv({ cls: "volis-edge-toolbar is-hidden" });
    this.edgeBar.addEventListener("pointerdown", (evt) => evt.stopPropagation());
    this.edgeBar.addEventListener("dblclick", (evt) => evt.stopPropagation());

    this.zoomEl = this.root.createDiv({ cls: "volis-board-zoom", text: "100%" });
    // Starts hidden: the board may already have content, and the hint must not
    // appear for a few frames before the file finishes loading.
    this.hintEl = this.root.createDiv({ cls: "volis-board-hint is-hidden" });
    this.hintEl.createDiv({ cls: "volis-hint-title", text: "空白白板" });
    this.hintEl.createDiv({
      cls: "volis-hint-sub",
      text: "拖入卡片或文件 · 双击空白处新建卡片 · 滚轮缩放 · 空格拖动平移",
    });

    this.root.addEventListener("wheel", this.onWheel, { passive: false });
    this.root.addEventListener("pointerdown", this.onPointerDown);
    this.root.addEventListener("pointermove", this.onPointerMove);
    this.root.addEventListener("pointerup", this.onPointerUp);
    this.root.addEventListener("pointercancel", this.onPointerUp);
    this.root.addEventListener("dblclick", this.onDoubleClick);
    this.root.addEventListener("dragover", this.onDragOver);
    this.root.addEventListener("dragleave", this.onDragLeave);
    this.root.addEventListener("drop", this.onDrop);

    this.world.addEventListener("pointerdown", (evt) => {
      const target = evt.target as Element | null;
      if (!(target instanceof SVGElement)) return;
      const group = target.closest(".volis-edge-group") as SVGGElement | null;
      const edgeId = group?.dataset.edgeId ?? null;
      if (!edgeId) return;
      evt.stopPropagation();
      this.selectEdge(edgeId);
    });

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.root);
    this.register(() => this.resizeObserver?.disconnect());
  }

  private async loadFromJson(raw: string): Promise<void> {
    let data: BoardData | null = null;
    try {
      const parsed = JSON.parse(raw) as BoardData;
      if (parsed && Array.isArray(parsed.nodes)) data = parsed;
    } catch (error) {
      data = null;
    }

    if (!data && raw.trim()) {
      this.rawFallback = raw;
      this.nodes = [];
      this.nodeMap.clear();
      this.nodeEls.clear();
      this.selection.clear();
      this.staleIds.clear();
      if (this.world) this.world.empty();
      this.updateHint();
      this.updateToolbar();
      new Notice("白板文件无法解析，已保护原文件不被覆盖");
      return;
    }

    this.rawFallback = null;

    // Restore the viewport before painting anything, otherwise the nodes are
    // laid out at the default zoom for one frame and visibly jump.
    const rect = this.root.getBoundingClientRect();
    if (data?.viewport) {
      this.tx = data.viewport.tx;
      this.ty = data.viewport.ty;
      this.scale = data.viewport.scale;
    } else {
      this.tx = rect.width / 2;
      this.ty = rect.height / 2;
      this.scale = 1;
    }

    this.world.style.visibility = "hidden";
    // The hint sits outside the world layer, so it has to be hidden for the
    // same span, otherwise it flashes over the incoming board.
    this.hintEl.addClass("is-hidden");

    try {
      this.world.empty();
      this.edgesEl = null;
      this.frameEl = null;
      this.ensureLayers();
      this.nodeEls.clear();
      this.selection.clear();

      this.nodes = data?.nodes ?? [];
      this.edges = data?.edges ?? [];
      this.nodeMap = new Map(this.nodes.map((node) => [node.id, node]));

      this.applyTransform();

      try {
        await Promise.all(this.nodes.map((node) => this.renderNode(node)));
      } catch (error) {
        console.error("[Volis] node render failed", error);
      }

      this.renderEdges();
    } finally {
      this.world.style.visibility = "";
    }

    this.updateHint();
    this.resetHistory();
  }

  private selectedNodes(): BoardNode[] {
    const out: BoardNode[] = [];
    for (const id of this.selection) {
      const node = this.nodeMap.get(id);
      if (node) out.push(node);
    }
    return out;
  }

  private isOpenable(node: BoardNode): boolean {
    return node.type === "card" || node.type === "file";
  }

  private openNode(node: BoardNode, mode: "tab" | "window"): void {
    if (node.type === "text") return;

    if (node.type === "card") {
      void this.openCardView(node, mode);
      return;
    }

    if (node.type === "group") return;

    const file = this.app.vault.getAbstractFileByPath(node.file);
    if (!(file instanceof TFile)) return;

    const leaf = this.app.workspace.getLeaf(mode === "window" ? "window" : "tab");
    void leaf.openFile(file);
  }

  /**
   * A card lives inside a shared month note, so opening the note would show
   * dozens of unrelated cards. Instead we keep a one-line note per card that
   * embeds just that block — opening it shows exactly that card, and it stays
   * in sync because it is an embed, not a copy.
   */
  private async openCardView(node: CardNode, mode: "tab" | "window"): Promise<void> {
    const source = this.app.vault.getAbstractFileByPath(node.file);
    if (!(source instanceof TFile)) {
      new Notice("源笔记不存在");
      return;
    }

    const baseName = source.basename;
    const path = `${baseName}-${node.blockId}.md`;
    const embed = `![[${node.file.replace(/\.md$/, "")}#^${node.blockId}]]\n`;

    try {
      let file = this.app.vault.getAbstractFileByPath(path) as TFile | null;

      if (!file) {
        file = await this.app.vault.create(path, embed);
      } else {
        const current = await this.app.vault.read(file);
        if (current.trim() !== embed.trim()) {
          await this.app.vault.modify(file, embed);
        }
      }

      const leaf = this.app.workspace.getLeaf(mode === "window" ? "window" : "tab");
      await leaf.openFile(file, { state: { mode: "preview" } });
    } catch (error) {
      console.error("[Volis] open card view failed", error);
      new Notice("打开卡片失败");
    }
  }

  /**
   * Named colours ride on `data-color`; a custom pick is a hex value applied as
   * a CSS variable, so the tinted background is derived by CSS itself and the
   * theme stays in charge of how light it gets.
   */
  /**
   * Colour is applied inline, not through CSS classes: node styling is spread
   * across several rules with different specificity, and inline values are the
   * only thing that cannot be overridden by any of them.
   */
  private paintColor(el: HTMLElement, color: string | undefined): void {
    el.style.removeProperty("background");
    el.style.removeProperty("border-color");

    if (!color) return;

    if (color.startsWith("#")) {
      if (el.classList.contains("is-group")) {
        el.style.borderColor = color;
        el.style.setProperty("--group-tint", color);
        el.style.background = `${color}14`;
        return;
      }

      el.style.background = this.tintOf(color);
      el.style.borderColor = color;
      return;
    }

    const preset = NODE_COLORS.find((item) => item.name === color);
    if (!preset) return;

    if (el.classList.contains("is-group")) {
      el.style.borderColor = preset.line;
      el.style.setProperty("--group-tint", preset.line);
      el.style.background = `${preset.line}14`;
      return;
    }

    el.style.background = preset.bg;
    el.style.borderColor = preset.line;
  }

  /** Blend a colour towards the page background, light or dark. */
  private tintOf(hex: string, amount = 0.84): string {
    const raw = hex.replace("#", "");
    if (raw.length !== 6) return hex;

    const num = parseInt(raw, 16);
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;

    const dark = document.body.classList.contains("theme-dark");
    const base = dark ? 26 : 255;
    const blend = (channel: number) => Math.round(channel + (base - channel) * amount);

    return `#${[blend(r), blend(g), blend(b)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("")}`;
  }

  private closeAlignPop(): void {
    if (this.alignOutside) {
      document.removeEventListener("mousedown", this.alignOutside, true);
      this.alignOutside = null;
    }
    this.alignPop?.remove();
    this.alignPop = null;
  }

  private showAlignPop(nodes: BoardNode[], evt: MouseEvent): void {
    this.closeAlignPop();
    if (nodes.length < 2) return;

    const pop = this.root.createDiv({ cls: "volis-align-pop" });
    this.alignPop = pop;
    pop.addEventListener("pointerdown", (event) => event.stopPropagation());

    const actions: Array<{ icon: string; label: string; run: () => void }> = [
      { icon: "align-start-vertical", label: "左对齐", run: () => this.alignNodes(nodes, "left") },
      { icon: "align-center-vertical", label: "水平居中", run: () => this.alignNodes(nodes, "hcenter") },
      { icon: "align-end-vertical", label: "右对齐", run: () => this.alignNodes(nodes, "right") },
      { icon: "align-horizontal-distribute-center", label: "水平等距", run: () => this.distributeNodes(nodes, "h") },
      { icon: "align-start-horizontal", label: "上对齐", run: () => this.alignNodes(nodes, "top") },
      { icon: "align-center-horizontal", label: "垂直居中", run: () => this.alignNodes(nodes, "vcenter") },
      { icon: "align-end-horizontal", label: "下对齐", run: () => this.alignNodes(nodes, "bottom") },
      { icon: "align-vertical-distribute-center", label: "垂直等距", run: () => this.distributeNodes(nodes, "v") },
    ];

    for (const action of actions) {
      const button = pop.createEl("button", {
        cls: "volis-tool-btn",
        attr: { "aria-label": action.label },
      });
      setIcon(button, action.icon);
      button.addEventListener("click", () => action.run());
    }

    const rect = this.root.getBoundingClientRect();
    const width = 168;
    pop.style.left = `${Math.round(Math.max(8, Math.min(evt.clientX - rect.left - 40, rect.width - width - 8)))}px`;
    pop.style.top = `${Math.round(Math.max(8, evt.clientY - rect.top + 12))}px`;

    this.alignOutside = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && pop.contains(target)) return;
      this.closeAlignPop();
    };
    document.addEventListener("mousedown", this.alignOutside, true);
  }

  private applyNodeGeometry(node: BoardNode): void {
    const el = this.nodeEls.get(node.id);
    if (!el) return;

    el.style.transform = `translate3d(${node.x}px, ${node.y}px, 0)`;
    el.style.width = `${node.width}px`;
    if (node.height) el.style.height = `${node.height}px`;
  }

  private afterLayout(): void {
    this.renderEdges();
    this.updateFrame();
    this.pushHistory();
    this.scheduleSave();
  }

  private alignNodes(nodes: BoardNode[], mode: string): void {
    const items = nodes.map((node) => ({ node, height: this.nodeHeight(node) }));
    if (items.length < 2) return;

    const minX = Math.min(...items.map((item) => item.node.x));
    const maxX = Math.max(...items.map((item) => item.node.x + item.node.width));
    const minY = Math.min(...items.map((item) => item.node.y));
    const maxY = Math.max(...items.map((item) => item.node.y + item.height));

    for (const { node, height } of items) {
      switch (mode) {
        case "left":
          node.x = Math.round(minX);
          break;
        case "right":
          node.x = Math.round(maxX - node.width);
          break;
        case "hcenter":
          node.x = Math.round((minX + maxX) / 2 - node.width / 2);
          break;
        case "top":
          node.y = Math.round(minY);
          break;
        case "bottom":
          node.y = Math.round(maxY - height);
          break;
        case "vcenter":
          node.y = Math.round((minY + maxY) / 2 - height / 2);
          break;
        default:
          break;
      }
      this.applyNodeGeometry(node);
    }

    this.afterLayout();
  }

  private distributeNodes(nodes: BoardNode[], axis: "h" | "v"): void {
    if (nodes.length < 3) return;

    const items = nodes.map((node) => ({ node, height: this.nodeHeight(node) }));

    if (axis === "h") {
      items.sort((a, b) => a.node.x - b.node.x);

      const first = items[0];
      const last = items[items.length - 1];
      const start = first.node.x + first.node.width;
      const end = last.node.x;
      const middle = items.slice(1, -1);
      const used = middle.reduce((sum, item) => sum + item.node.width, 0);
      const gap = (end - start - used) / (items.length - 1);

      let cursor = start;
      for (const item of middle) {
        cursor += gap;
        item.node.x = Math.round(cursor);
        this.applyNodeGeometry(item.node);
        cursor += item.node.width;
      }
    } else {
      items.sort((a, b) => a.node.y - b.node.y);

      const first = items[0];
      const last = items[items.length - 1];
      const start = first.node.y + first.height;
      const end = last.node.y;
      const middle = items.slice(1, -1);
      const used = middle.reduce((sum, item) => sum + item.height, 0);
      const gap = (end - start - used) / (items.length - 1);

      let cursor = start;
      for (const item of middle) {
        cursor += gap;
        item.node.y = Math.round(cursor);
        this.applyNodeGeometry(item.node);
        cursor += item.height;
      }
    }

    this.afterLayout();
  }

  private closeColorPop(): void {
    this.colorPop?.remove();
    this.colorPop = null;
    if (this.colorOutside) {
      document.removeEventListener("mousedown", this.colorOutside, true);
      this.colorOutside = null;
    }
  }

  private showColorPop(nodes: BoardNode[], evt: MouseEvent): void {
    this.closeColorPop();
    if (nodes.length === 0) return;

    const pop = this.root.createDiv({ cls: "volis-color-pop" });
    this.colorPop = pop;

    pop.addEventListener("pointerdown", (event) => event.stopPropagation());

    for (const color of NODE_COLORS) {
      const swatch = pop.createEl("button", {
        cls: "volis-swatch",
        attr: { "aria-label": color.label },
      });
      swatch.dataset.color = color.name;
      swatch.addEventListener("click", () => {
        this.applyNodeColor(nodes, color.name);
        this.closeColorPop();
      });
    }

    const custom = pop.createEl("label", {
      cls: "volis-swatch is-custom",
      attr: { "aria-label": "自定义颜色" },
    });
    const picker = custom.createEl("input", { attr: { type: "color" } });
    picker.value = this.currentColorOf(nodes) ?? "#7f77dd";
    picker.addEventListener("input", () => {
      this.applyNodeColor(nodes, picker.value);
    });
    picker.addEventListener("change", () => {
      this.applyNodeColor(nodes, picker.value);
      this.closeColorPop();
    });

    const clear = pop.createEl("button", {
      cls: "volis-swatch is-clear",
      attr: { "aria-label": "无颜色" },
    });
    setIcon(clear, "ban");
    clear.addEventListener("click", () => {
      this.applyNodeColor(nodes, "");
      this.closeColorPop();
    });

    const rect = this.root.getBoundingClientRect();
    const popWidth = 240;
    pop.style.left = `${Math.round(Math.max(8, Math.min(evt.clientX - rect.left - 20, rect.width - popWidth - 8)))}px`;
    pop.style.top = `${Math.round(Math.max(8, evt.clientY - rect.top + 12))}px`;

    this.colorOutside = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && pop.contains(target)) return;
      this.closeColorPop();
    };
    document.addEventListener("mousedown", this.colorOutside, true);
  }

  private currentColorOf(nodes: BoardNode[]): string | null {
    return nodes[0]?.color ?? null;
  }

  private applyNodeColor(nodes: BoardNode[], color: string): void {
    const ids = new Set(nodes.map((node) => node.id));

    for (const node of this.nodes) {
      if (!ids.has(node.id)) continue;

      if (color) node.color = color;
      else delete node.color;

      const el = this.nodeEls.get(node.id);
      if (!el) continue;

      this.paintColor(el, color || undefined);
    }

    this.pushHistory();
    this.scheduleSave();
  }

  private showMoreMenu(node: BoardNode, evt: MouseEvent): void {
    const menu = new Menu();

    if (node.type === "text") {
      menu.addItem((item) =>
        item
          .setTitle("转为卡片笔记")
          .setIcon("list")
          .onClick(() => {
            void this.convertToCard(node);
          })
      );
    }

    if (node.type === "text" || node.type === "card") {
      menu.addItem((item) =>
        item
          .setTitle("转为独立笔记")
          .setIcon("file-text")
          .onClick(() => {
            if (node.type === "text") void this.convertToNote(node);
            else void this.convertCardToNote(node);
          })
      );
    }

    menu.showAtMouseEvent(evt);
  }

  private deriveTitle(text: string): string {
    const first = text.split("\n")[0] ?? "";
    const cleaned = first
      .replace(/#[\p{L}\p{N}_/-]+/gu, " ")
      .replace(/[\\/:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return cleaned.slice(0, 15).trim() || "未命名";
  }

  private async convertCardToNote(node: BoardNode): Promise<void> {
    if (node.type !== "card") return;

    const current = this.nodeMap.get(node.id);
    if (!current || current.type !== "card") return;

    const meta = await readCard(this.app, {
      file: current.file,
      blockId: current.blockId,
      linkpath: "",
    });

    if (meta.stale) {
      new Notice("卡片已不存在");
      return;
    }

    const text = meta.editable.trim();
    if (!text) {
      new Notice("卡片内容为空");
      return;
    }

    const title = this.deriveTitle(text);
    const link = `[[${current.file.replace(/\.md$/, "")}#^${current.blockId}]]`;
    const content = `---\nsource: "${link}"\n---\n\n${text}\n`;

    const folder = this.plugin.settings.boardFolder ?? "";
    const file = await createNoteFromText(this.app, folder, content, title);
    if (!file) {
      new Notice("转换失败：无法创建笔记");
      return;
    }

    const next: FileNode = {
      id: current.id,
      type: "file",
      file: file.path,
      x: current.x,
      y: current.y,
      width: current.width,
      height: current.height ?? 320,
    };

    const index = this.nodes.findIndex((item) => item.id === current.id);
    if (index === -1) return;

    this.nodes[index] = next;
    this.nodeMap.set(next.id, next);

    this.detachNodeElement(next.id);
    await this.renderNode(next);

    this.pushHistory();
    this.scheduleSave();
    this.updateToolbar();
    new Notice("已转为独立笔记，源卡片保留");
  }

  private async convertToCard(node: BoardNode): Promise<void> {
    const current = this.nodeMap.get(node.id);
    if (!current || current.type !== "text") return;

    const text = current.text.trim();
    if (!text) {
      new Notice("内容为空，无法转换");
      return;
    }

    const folder = await resolveCardFolder(this.app, this.plugin.settings.cardFolder);
    const result = await appendCard(this.app, folder, text);

    if (!result) {
      new Notice("转换失败：写入卡片文件后校验未通过");
      return;
    }

    // Remove the text node, then re-add the freshly written card through the
    // same path a drop uses. That path is known to render correctly.
    const { x, y, width, height } = current;

    this.nodes = this.nodes.filter((item) => item.id !== current.id);
    this.nodeMap.delete(current.id);
    this.selection.delete(current.id);
    this.detachNodeElement(current.id);

    const added = await this.addCardNodeAt(result.file, result.blockId, x, y, width, height);
    if (!added) {
      new Notice("卡片已写入笔记，但未能添加到白板");
      this.scheduleSave();
      return;
    }

    this.selection.clear();
    this.selection.add(added.id);
    this.paintSelection();
    this.updateHint();
    this.pushHistory();
    this.updateToolbar();
    new Notice("已转为卡片笔记");
  }

  private async addCardNodeAt(
    file: string,
    blockId: string,
    x: number,
    y: number,
    width: number,
    height?: number
  ): Promise<CardNode | null> {
    const node: CardNode = {
      id: createId(),
      type: "card",
      file,
      blockId,
      x,
      y,
      width,
      height,
    };

    this.nodes.push(node);
    this.nodeMap.set(node.id, node);

    await this.renderNode(node);

    this.scheduleSave();
    return node;
  }

  private async convertToNote(node: BoardNode): Promise<void> {
    const current = this.nodeMap.get(node.id);
    if (!current || current.type !== "text") return;

    const text = current.text.trim();
    if (!text) {
      new Notice("内容为空，无法转换");
      return;
    }

    const file = await createNoteFromText(this.app, this.plugin.settings.boardFolder ?? "", text);
    if (!file) {
      new Notice("转换失败：无法创建笔记文件");
      return;
    }

    const next: FileNode = {
      id: current.id,
      type: "file",
      file: file.path,
      x: current.x,
      y: current.y,
      width: current.width,
      height: current.height ?? Math.max(120, current.width * 0.75),
    };

    const index = this.nodes.findIndex((item) => item.id === current.id);
    if (index === -1) return;

    this.nodes[index] = next;
    this.nodeMap.set(next.id, next);

    this.detachNodeElement(next.id);
    await this.renderNode(next);

    this.pushHistory();
    this.scheduleSave();
    this.updateToolbar();
    new Notice("已转为独立笔记");
  }

  private buildToolbarActions(): ToolbarAction[] {
    const single = (nodes: BoardNode[]) => nodes.length === 1;
    const canOpen = (nodes: BoardNode[]) => nodes.length === 1 && this.isOpenable(nodes[0]);

    return [
      {
        id: "open-tab",
        icon: "external-link",
        label: "在新标签页打开",
        visible: single,
        enabled: canOpen,
        run: (nodes) => this.openNode(nodes[0], "tab"),
      },
      {
        id: "open-window",
        icon: "app-window",
        label: "在新窗口打开",
        visible: single,
        enabled: canOpen,
        run: (nodes) => this.openNode(nodes[0], "window"),
      },
      {
        id: "group",
        icon: "group",
        label: "创建分组",
        visible: (nodes) => nodes.length > 1,
        run: () => void this.createGroupFromSelection(),
      },
      {
        id: "align",
        icon: "align-start-vertical",
        label: "对齐",
        visible: (nodes) => nodes.length >= 2,
        run: (nodes, evt) => this.showAlignPop(nodes, evt),
      },
      {
        id: "color",
        icon: "palette",
        label: "颜色",
        run: (nodes, evt) => this.showColorPop(nodes, evt),
      },
      {
        id: "more",
        icon: "more-horizontal",
        label: "更多",
        visible: (nodes) =>
          nodes.length === 1 && (nodes[0].type === "text" || nodes[0].type === "card"),
        run: (nodes, evt) => this.showMoreMenu(nodes[0], evt),
      },
      {
        id: "ungroup",
        icon: "ungroup",
        label: "取消分组",
        visible: (nodes) => nodes.length === 1 && nodes[0].type === "group",
        run: () => this.deleteSelection(),
      },
      {
        id: "delete",
        icon: "trash-2",
        label: "删除",
        danger: true,
        run: () => this.deleteSelection(),
      },
    ];
  }

  /**
   * The bar lives outside the transformed world, so it keeps a constant size at
   * any zoom level. Position is recomputed from the selection's screen box.
   */
  /**
   * Clicking the tab title renames the board. Renaming goes through the file
   * manager, so anything pointing at this board is rewritten just like it is
   * for a normal note.
   */
  private onHeaderTitleClick = (evt: MouseEvent): void => {
    const target = evt.target as HTMLElement | null;
    if (!target || !target.closest(".view-header-title")) return;

    const file = this.file;
    if (!file) return;

    evt.preventDefault();
    evt.stopPropagation();

    new RenameModal(this.app, file.basename, (value) => {
      void this.renameBoard(file, value);
    }).open();
  };

  private async renameBoard(file: TFile, value: string): Promise<void> {
    const name = value.replace(/\.volis$/i, "").trim();
    if (!name || name === file.basename) return;

    const folder = file.parent?.path ?? "";
    const prefix = folder && folder !== "/" ? `${folder}/` : "";

    try {
      await this.app.fileManager.renameFile(file, `${prefix}${name}.volis`);
    } catch (error) {
      new Notice("重命名失败：名称可能重复或包含非法字符");
    }
  }

  private hasEditingNode(): boolean {
    for (const el of this.nodeEls.values()) {
      if (el.hasClass("volis-editing")) return true;
    }
    return false;
  }

  private minimapWorld(): { x: number; y: number; w: number; h: number } | null {
    if (this.nodes.length === 0) return null;

    const rect = this.root.getBoundingClientRect();
    const viewLeft = -this.tx / this.scale;
    const viewTop = -this.ty / this.scale;
    const viewRight = viewLeft + rect.width / this.scale;
    const viewBottom = viewTop + rect.height / this.scale;

    let minX = viewLeft;
    let minY = viewTop;
    let maxX = viewRight;
    let maxY = viewBottom;

    for (const node of this.nodes) {
      const height = this.nodeHeight(node);
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + height);
    }

    const pad = 60;
    let x = minX - pad;
    let y = minY - pad;
    let w = Math.max(1, maxX - minX + pad * 2);
    let h = Math.max(1, maxY - minY + pad * 2);

    // Match the container's aspect ratio so the viewBox fills it exactly.
    const aspect = 180 / 120;
    if (w / h < aspect) {
      const nextW = h * aspect;
      x -= (nextW - w) / 2;
      w = nextW;
    } else {
      const nextH = w / aspect;
      y -= (nextH - h) / 2;
      h = nextH;
    }

    return { x, y, w, h };
  }

  private updateMinimap(): void {
    const el = this.minimapEl;
    const svg = this.minimapSvg;
    if (!el || !svg) return;

    if (this.nodes.length === 0) {
      el.addClass("is-hidden");
      return;
    }

    const world = this.minimapWorld();
    if (!world) {
      el.addClass("is-hidden");
      return;
    }

    el.removeClass("is-hidden");

    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.setAttribute("viewBox", `${world.x} ${world.y} ${world.w} ${world.h}`);

    for (const node of this.nodes) {
      const rect = this.svgNode("rect");
      rect.setAttribute("x", String(node.x));
      rect.setAttribute("y", String(node.y));
      rect.setAttribute("width", String(node.width));
      rect.setAttribute("height", String(this.nodeHeight(node)));
      rect.setAttribute("rx", node.type === "group" ? "8" : "4");
      rect.setAttribute("class", `volis-mini-node is-${node.type}`);
      svg.appendChild(rect);
    }

    const view = this.svgNode("rect");
    const rootRect = this.root.getBoundingClientRect();
    const viewLeft = -this.tx / this.scale;
    const viewTop = -this.ty / this.scale;

    view.setAttribute("x", String(viewLeft));
    view.setAttribute("y", String(viewTop));
    view.setAttribute("width", String(rootRect.width / this.scale));
    view.setAttribute("height", String(rootRect.height / this.scale));
    view.setAttribute("rx", "6");
    view.setAttribute("class", "volis-mini-view");
    svg.appendChild(view);
  }

  private jumpToMinimapPoint(clientX: number, clientY: number): void {
    const svg = this.minimapSvg;
    const el = this.minimapEl;
    if (!svg || !el) return;

    const box = svg.viewBox.baseVal;
    if (box.width === 0 || box.height === 0) return;

    const rect = el.getBoundingClientRect();
    const padding = 4;

    const relX = (clientX - rect.left - padding) / Math.max(1, rect.width - padding * 2);
    const relY = (clientY - rect.top - padding) / Math.max(1, rect.height - padding * 2);

    const worldX = box.x + Math.min(1, Math.max(0, relX)) * box.width;
    const worldY = box.y + Math.min(1, Math.max(0, relY)) * box.height;

    const rootRect = this.root.getBoundingClientRect();
    this.tx = rootRect.width / 2 - worldX * this.scale;
    this.ty = rootRect.height / 2 - worldY * this.scale;

    this.applyTransform();
    this.scheduleSave();
  }

  private onMinimapDown = (evt: PointerEvent): void => {
    evt.preventDefault();
    evt.stopPropagation();

    this.minimapDragging = true;
    this.jumpToMinimapPoint(evt.clientX, evt.clientY);

    const move = (event: PointerEvent) => {
      if (!this.minimapDragging) return;
      this.jumpToMinimapPoint(event.clientX, event.clientY);
    };

    const up = () => {
      this.minimapDragging = false;
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };

    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  };

  private updateToolbar(): void {
    if (!this.toolbarEl) return;

    const nodes = this.selectedNodes();

    if (nodes.length === 0 || this.hasEditingNode()) {
      this.toolbarEl.addClass("is-hidden");
      return;
    }

    const actions = this.buildToolbarActions().filter(
      (action) => !action.visible || action.visible(nodes)
    );
    if (actions.length === 0) {
      this.toolbarEl.addClass("is-hidden");
      return;
    }

    const key = actions
      .map((action) => `${action.id}:${action.enabled ? action.enabled(nodes) : true}`)
      .join(",");
    if (key !== this.toolbarKey) {
      this.toolbarKey = key;
      this.toolbarEl.empty();
      for (const action of actions) {
        const button = this.toolbarEl.createEl("button", {
          cls: `volis-tool-btn${action.danger ? " is-danger" : ""}`,
          attr: { "aria-label": action.label },
        });
        button.disabled = action.enabled ? !action.enabled(nodes) : false;
        setIcon(button, action.icon);
        button.addEventListener("click", (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          action.run(this.selectedNodes(), evt);
        });
      }
    }

    const rect = this.root.getBoundingClientRect();
    const box = this.selectionBox(nodes);
    if (!box) {
      this.toolbarEl.addClass("is-hidden");
      return;
    }

    const left = box.minX * this.scale + this.tx;
    const right = box.maxX * this.scale + this.tx;
    const top = box.minY * this.scale + this.ty;
    const bottom = box.maxY * this.scale + this.ty;

    if (right < 0 || left > rect.width || bottom < 0 || top > rect.height) {
      this.toolbarEl.addClass("is-hidden");
      return;
    }

    this.toolbarEl.removeClass("is-hidden");

    const barWidth = this.toolbarEl.offsetWidth || 110;
    const barHeight = this.toolbarEl.offsetHeight || 36;

    let x = (left + right) / 2 - barWidth / 2;
    let y = top - barHeight - 10;

    if (y < 6) y = bottom + 10;

    x = Math.max(6, Math.min(x, rect.width - barWidth - 6));
    y = Math.max(6, Math.min(y, rect.height - barHeight - 6));

    this.toolbarEl.style.left = `${Math.round(x)}px`;
    this.toolbarEl.style.top = `${Math.round(y)}px`;
  }

  private selectionBox(nodes: BoardNode[]): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of nodes) {
      const el = this.nodeEls.get(node.id);
      const height = el?.offsetHeight ?? 100;
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + height);
    }

    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
  }

  private snapshotNodes(): string {
    return JSON.stringify({ nodes: this.nodes, edges: this.edges });
  }

  private resetHistory(): void {
    this.history = [this.snapshotNodes()];
    this.historyIndex = 0;
    this.updateHistoryButtons();
  }

  private pushHistory(): void {
    const snap = this.snapshotNodes();
    if (this.historyIndex >= 0 && this.history[this.historyIndex] === snap) return;

    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(snap);

    if (this.history.length > BoardView.HISTORY_LIMIT) this.history.shift();
    this.historyIndex = this.history.length - 1;
    this.updateHistoryButtons();
  }

  private copySelection(): void {
    if (this.selection.size === 0) return;

    const ids = new Set(this.selection);
    this.clipboard = this.nodes
      .filter((node) => ids.has(node.id))
      .map((node) => ({ ...node }));
    this.clipboardEdges = this.edges
      .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
      .map((edge) => ({ ...edge }));
  }

  private async pasteClipboard(): Promise<void> {
    if (this.clipboard.length === 0) return;

    const boxOf = (nodes: BoardNode[]) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (const node of nodes) {
        const height = this.nodeHeight(node);
        minX = Math.min(minX, node.x);
        minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x + node.width);
        maxY = Math.max(maxY, node.y + height);
      }

      return { minX, minY, maxX, maxY };
    };

    const box = boxOf(this.clipboard);
    let dx = 24;
    let dy = 24;

    if (this.lastPointerWorld && Number.isFinite(box.minX)) {
      dx = this.lastPointerWorld.x - (box.minX + box.maxX) / 2;
      dy = this.lastPointerWorld.y - (box.minY + box.maxY) / 2;
    }

    const idMap = new Map<string, string>();
    const copies = this.clipboard.map((node) => {
      const id = createId();
      idMap.set(node.id, id);
      return {
        ...node,
        id,
        x: Math.round(node.x + dx),
        y: Math.round(node.y + dy),
      } as BoardNode;
    });

    const edges = this.clipboardEdges
      .map((edge) => ({
        ...edge,
        id: createId(),
        from: idMap.get(edge.from) ?? "",
        to: idMap.get(edge.to) ?? "",
      }))
      .filter((edge) => edge.from && edge.to);

    this.nodes.push(...copies);
    for (const node of copies) this.nodeMap.set(node.id, node);
    this.edges.push(...edges);

    try {
      await Promise.all(copies.map((node) => this.renderNode(node)));
    } catch (error) {
      console.error("[Volis] paste render failed", error);
    }

    this.renderEdges();

    this.selection.clear();
    for (const node of copies) this.selection.add(node.id);

    this.paintSelection();
    this.updateHint();
    this.pushHistory();
    this.scheduleSave();
  }

  private async undo(): Promise<void> {
    if (this.hasEditingNode()) {
      new Notice("请先结束编辑再撤销");
      return;
    }
    if (this.historyIndex <= 0) return;
    this.historyIndex -= 1;
    await this.restoreSnapshot(this.history[this.historyIndex]);
    this.updateHistoryButtons();
  }

  private async redo(): Promise<void> {
    if (this.hasEditingNode()) {
      new Notice("请先结束编辑再重做");
      return;
    }
    if (this.historyIndex >= this.history.length - 1) return;
    this.historyIndex += 1;
    await this.restoreSnapshot(this.history[this.historyIndex]);
    this.updateHistoryButtons();
  }

  private async restoreSnapshot(snapshot: string): Promise<void> {
    let next: BoardNode[] = [];
    let nextEdges: BoardEdge[] = [];

    try {
      const parsed = JSON.parse(snapshot) as unknown;
      if (Array.isArray(parsed)) {
        next = parsed as BoardNode[];
      } else {
        const value = parsed as { nodes?: BoardNode[]; edges?: BoardEdge[] };
        next = value.nodes ?? [];
        nextEdges = value.edges ?? [];
      }
    } catch (error) {
      return;
    }

    this.ensureLayers();

    this.selection.clear();
    this.staleIds.clear();

    const nextIds = new Set(next.map((node) => node.id));

    // Drop nodes that no longer exist.
    for (const [id, el] of Array.from(this.nodeEls.entries())) {
      if (nextIds.has(id)) continue;
      el.remove();
      this.nodeEls.delete(id);
    }

    const previousMap = this.nodeMap;
    this.nodes = next;
    this.edges = nextEdges;
    this.nodeMap = new Map(next.map((node) => [node.id, node]));

    // Rebuild only what actually changed; a moved node just gets new geometry,
    // so images and videos are not reloaded.
    const rebuilds: Promise<HTMLElement>[] = [];

    for (const node of next) {
      const el = this.nodeEls.get(node.id);
      const previous = previousMap.get(node.id);

      if (!el || !previous || this.nodeContentChanged(previous, node)) {
        rebuilds.push(this.renderNode(node));
        continue;
      }

      el.style.transform = `translate3d(${node.x}px, ${node.y}px, 0)`;
      el.style.width = `${node.width}px`;
      if (node.height) el.style.height = `${node.height}px`;
      else el.style.removeProperty("height");
    }

    try {
      await Promise.all(rebuilds);
    } catch (error) {
      console.error("[Volis] node rebuild failed", error);
    }

    this.renderEdges();
    this.updateHint();
    this.updateFrame();
    this.scheduleSave();
  }

  private nodeContentChanged(a: BoardNode, b: BoardNode): boolean {
    if (a.type !== b.type) return true;
    if (a.type === "text" && b.type === "text") return a.text !== b.text;
    if (a.type === "card" && b.type === "card") {
      return a.file !== b.file || a.blockId !== b.blockId;
    }
    if (a.type === "file" && b.type === "file") return a.file !== b.file;
    return false;
  }

  private deleteSelection(): void {
    if (this.selection.size === 0) return;

    // Never remove a node that is currently being edited: its editor instance
    // would be destroyed with the DOM while still holding listeners.
    const ids = new Set<string>();
    for (const id of this.selection) {
      const el = this.nodeEls.get(id);
      if (el && el.hasClass("volis-editing")) continue;
      ids.add(id);
    }
    if (ids.size === 0) return;

    this.nodes = this.nodes.filter((node) => !ids.has(node.id));

    for (const id of ids) {
      const el = this.nodeEls.get(id);
      if (el) el.remove();
      this.nodeEls.delete(id);
      this.nodeMap.delete(id);
      this.staleIds.delete(id);
    }

    this.edges = this.edges.filter((edge) => !ids.has(edge.from) && !ids.has(edge.to));
    this.selectedEdgeId = null;
    this.renderEdges();

    this.selection.clear();
    this.updateFrame();
    this.updateHint();
    this.pushHistory();
    this.scheduleSave();
  }

  private updateHint(): void {
    this.hintEl.toggleClass("is-hidden", this.nodes.length > 0);
  }

  /**
   * Drop a node's DOM element and index entry so the next render must build it
   * from scratch, even if an editor happens to still be attached.
   */
  private detachNodeElement(nodeId: string): void {
    const el = this.nodeEls.get(nodeId);
    if (!el) return;
    el.classList.remove("volis-editing");
    el.remove();
    this.nodeEls.delete(nodeId);
  }

  private ensureLayers(): void {
    if (!this.edgesEl || !this.world.contains(this.edgesEl)) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.classList.add("volis-edges");
      this.world.prepend(svg);
      this.edgesEl = svg;
    }

    if (!this.frameEl || !this.world.contains(this.frameEl)) {
      this.frameEl = this.world.createDiv({ cls: "volis-selection-frame is-hidden" });
    }
  }

  private svgNode<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
    return document.createElementNS("http://www.w3.org/2000/svg", tag);
  }

  private nodeHeight(node: BoardNode): number {
    return this.nodeEls.get(node.id)?.offsetHeight ?? node.height ?? 100;
  }

  /** Where the line leaves a node's box, heading towards `towards`. */
  private borderPoint(node: BoardNode, towards: BoardNode): { x: number; y: number } {
    return this.borderPointAt(
      node,
      towards.x + towards.width / 2,
      towards.y + this.nodeHeight(towards) / 2
    );
  }

  private borderPointAt(node: BoardNode, tx: number, ty: number): { x: number; y: number } {
    const cx = node.x + node.width / 2;
    const cy = node.y + this.nodeHeight(node) / 2;

    const dx = tx - cx;
    const dy = ty - cy;

    const halfW = node.width / 2;
    const halfH = this.nodeHeight(node) / 2;

    const scaleX = Math.abs(dx) < 0.001 ? Number.POSITIVE_INFINITY : halfW / Math.abs(dx);
    const scaleY = Math.abs(dy) < 0.001 ? Number.POSITIVE_INFINITY : halfH / Math.abs(dy);
    const scale = Math.min(scaleX, scaleY);

    if (!Number.isFinite(scale)) return { x: cx, y: cy };
    return { x: cx + dx * scale, y: cy + dy * scale };
  }

  private portPoint(
    node: BoardNode,
    side: PortSide,
    ratio = 0.5
  ): { x: number; y: number } {
    const height = this.nodeHeight(node);
    const clamped = Math.min(0.9, Math.max(0.1, ratio));

    switch (side) {
      case "top":
        return { x: node.x + node.width * clamped, y: node.y };
      case "bottom":
        return { x: node.x + node.width * clamped, y: node.y + height };
      case "left":
        return { x: node.x, y: node.y + height * clamped };
      default:
        return { x: node.x + node.width, y: node.y + height * clamped };
    }
  }

  private sideNormal(side: PortSide): { x: number; y: number } {
    switch (side) {
      case "top":
        return { x: 0, y: -1 };
      case "bottom":
        return { x: 0, y: 1 };
      case "left":
        return { x: -1, y: 0 };
      default:
        return { x: 1, y: 0 };
    }
  }

  /** Curve that leaves along the side's normal, like the native canvas does. */
  private orientedPath(
    p1: { x: number; y: number },
    side1: PortSide,
    p2: { x: number; y: number },
    side2: PortSide
  ): string {
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const offset = Math.max(28, Math.min(150, dist * 0.35));

    const n1 = this.sideNormal(side1);
    const n2 = this.sideNormal(side2);

    const c1 = { x: p1.x + n1.x * offset, y: p1.y + n1.y * offset };
    const c2 = { x: p2.x + n2.x * offset, y: p2.y + n2.y * offset };

    return `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`;
  }

  private nearestSide(node: BoardNode, x: number, y: number): PortSide {
    const height = this.nodeHeight(node);
    const cx = node.x + node.width / 2;
    const cy = node.y + height / 2;
    const dx = x - cx;
    const dy = y - cy;

    const nx = Math.abs(dx) / Math.max(1, node.width / 2);
    const ny = Math.abs(dy) / Math.max(1, height / 2);

    if (nx >= ny) return dx >= 0 ? "right" : "left";
    return dy >= 0 ? "bottom" : "top";
  }

  private edgePath(p1: { x: number; y: number }, p2: { x: number; y: number }): string {
    const horizontal = Math.abs(p2.x - p1.x) >= Math.abs(p2.y - p1.y);
    if (horizontal) {
      const mx = (p1.x + p2.x) / 2;
      return `M ${p1.x} ${p1.y} C ${mx} ${p1.y}, ${mx} ${p2.y}, ${p2.x} ${p2.y}`;
    }
    const my = (p1.y + p2.y) / 2;
    return `M ${p1.x} ${p1.y} C ${p1.x} ${my}, ${p2.x} ${my}, ${p2.x} ${p2.y}`;
  }

  private lineColorOf(color?: string): string | undefined {
    if (!color) return undefined;
    if (color.startsWith("#")) return color;
    return NODE_COLORS.find((item) => item.name === color)?.line;
  }

  private renderEdges(): void {
    if (!this.edgesEl || !this.world.contains(this.edgesEl)) this.ensureLayers();

    const svg = this.edgesEl;
    if (!svg) return;

    while (svg.firstChild) svg.removeChild(svg.firstChild);

    // Give the layer a real area covering the content instead of relying on
    // `overflow: visible`, which clips the strokes after a reload.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of this.nodes) {
      const height = this.nodeHeight(node);
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + height);
    }

    if (!Number.isFinite(minX)) {
      minX = 0;
      minY = 0;
      maxX = 1;
      maxY = 1;
    }

    const pad = 400;
    const vx = minX - pad;
    const vy = minY - pad;
    const vw = Math.max(1, maxX - minX + pad * 2);
    const vh = Math.max(1, maxY - minY + pad * 2);

    svg.setAttribute("viewBox", `${vx} ${vy} ${vw} ${vh}`);
    svg.style.left = `${vx}px`;
    svg.style.top = `${vy}px`;
    svg.style.width = `${vw}px`;
    svg.style.height = `${vh}px`;

    const defs = this.svgNode("defs");
    defs.innerHTML =
      '<marker id="volis-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/></marker>';
    svg.appendChild(defs);

    for (const edge of this.edges) {
      const from = this.nodeMap.get(edge.from);
      const to = this.nodeMap.get(edge.to);
      if (!from || !to) continue;

      const fromSide = edge.fromSide ?? this.nearestSide(from, to.x + to.width / 2, to.y);
      const toSide = edge.toSide ?? this.nearestSide(to, from.x + from.width / 2, from.y);

      const start = this.portPoint(from, fromSide);
      const end = this.portPoint(to, toSide);

      const d = this.orientedPath(start, fromSide, end, toSide);

      const group = this.svgNode("g");
      group.setAttribute("class", "volis-edge-group");
      group.dataset.edgeId = edge.id;
      if (edge.id === this.selectedEdgeId) group.classList.add("is-selected");

      // Wide invisible stroke: gives the line a forgiving click target.
      const hit = this.svgNode("path");
      hit.setAttribute("d", d);
      hit.setAttribute("class", "volis-edge-hit");

      const path = this.svgNode("path");
      path.setAttribute("d", d);
      path.setAttribute("class", "volis-edge");
      path.setAttribute("marker-end", "url(#volis-arrow)");
      if (edge.style === "dashed") path.setAttribute("stroke-dasharray", "6 4");

      const stroke = this.lineColorOf(edge.color);
      if (stroke) path.style.stroke = stroke;

      const arrow = edge.arrow ?? "target";
      if (arrow === "none") {
        path.removeAttribute("marker-end");
      } else {
        path.setAttribute("marker-end", "url(#volis-arrow)");
      }
      if (arrow === "both") {
        path.setAttribute("marker-start", "url(#volis-arrow)");
      }

      group.appendChild(hit);
      group.appendChild(path);
      svg.appendChild(group);
    }

  }

  private renderGroupBody(el: HTMLElement, node: GroupNode): void {
    el.addClass("is-group");
    this.nodeText.set(node.id, node.label ?? "");

    // The label is a real input: one click edits it, no double-click race with
    // the canvas drag handling.
    const input = document.createElement("input");
    input.className = "volis-group-label";
    input.type = "text";
    input.spellcheck = false;
    input.value = node.label ?? "分组";

    input.addEventListener("pointerdown", (evt) => evt.stopPropagation());
    input.addEventListener("dblclick", (evt) => evt.stopPropagation());
    input.addEventListener("focus", () => input.select());

    let committing = false;

    const commit = () => {
      if (committing) return;
      committing = true;

      node.label = input.value.trim() || "分组";
      input.value = node.label;
      this.pushHistory();
      this.scheduleSave();

      committing = false;
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (evt) => {
      evt.stopPropagation();

      if (evt.key === "Enter") {
        evt.preventDefault();
        input.blur();
      }
      if (evt.key === "Escape") {
        evt.preventDefault();
        input.value = node.label ?? "分组";
        input.blur();
      }
    });

    el.appendChild(input);
  }

  /** Nodes whose centre falls inside a group's box. Position is the only
   *  membership record, so dragging in and out just works. */
  private groupMembers(group: GroupNode): BoardNode[] {
    const left = group.x;
    const top = group.y;
    const right = group.x + group.width;
    const bottom = group.y + (group.height ?? 0);

    return this.nodes.filter((node) => {
      if (node.id === group.id || node.type === "group") return false;
      const height = this.nodeHeight(node);
      const cx = node.x + node.width / 2;
      const cy = node.y + height / 2;
      return cx >= left && cx <= right && cy >= top && cy <= bottom;
    });
  }

  private async createGroupFromSelection(): Promise<void> {
    const nodes = this.selectedNodes().filter((node) => node.type !== "group");
    if (nodes.length === 0) return;

    const box = this.selectionBox(nodes);
    if (!box) return;

    const pad = 40;
    const group: GroupNode = {
      id: createId(),
      type: "group",
      x: Math.round(box.minX - pad),
      y: Math.round(box.minY - pad - 14),
      width: Math.round(box.maxX - box.minX + pad * 2),
      height: Math.round(box.maxY - box.minY + pad * 2 + 14),
      label: "分组",
    };

    this.nodes.unshift(group);
    this.nodeMap.set(group.id, group);

    await this.renderNode(group);

    this.selection.clear();
    this.selection.add(group.id);
    this.paintSelection();
    this.updateHint();
    this.pushHistory();
    this.scheduleSave();
  }

  private async renderNode(node: BoardNode): Promise<HTMLElement> {
    const existing = this.nodeEls.get(node.id);
    if (existing && existing.hasClass("volis-editing")) return existing;

    this.staleIds.delete(node.id);

    const el = this.world.createDiv({ cls: "volis-bnode" });
    el.dataset.nodeId = node.id;
    el.style.width = `${node.width}px`;
    if (node.height) el.style.height = `${node.height}px`;
    el.style.transform = `translate3d(${node.x}px, ${node.y}px, 0)`;

    this.paintColor(el, node.color);

    for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const) {
      const handle = el.createDiv({ cls: "volis-resize-handle" });
      handle.dataset.dir = dir;
    }

    if (node.type !== "group") {
      for (const side of ["top", "right", "bottom", "left"] as const) {
        const port = el.createDiv({ cls: `volis-port is-${side}` });
        port.dataset.port = side;
      }
    }

    if (node.type === "group") {
      this.renderGroupBody(el, node);
    } else if (node.type === "text") {
      await this.renderTextBody(el, node);
    } else if (node.type === "card") {
      await this.renderCardBody(el, node);
    } else {
      await this.renderFileBody(el, node);
    }

    const previous = this.nodeEls.get(node.id);
    if (node.type === "group" && this.frameEl) {
      this.world.insertBefore(el, this.frameEl);
    }

    this.nodeEls.set(node.id, el);
    if (previous && previous !== el) previous.remove();

    this.updateToolbar();
    return el;
  }

  private async renderTextBody(el: HTMLElement, node: TextNode): Promise<void> {
    const body = el.createDiv({ cls: "volis-bnode-body" });
    this.nodeText.set(node.id, node.text);
    if (!node.text.trim()) return;
    await MarkdownRenderer.render(this.app, node.text, body, "", this);
    this.decorateNumericTags(body);
  }

  private async renderCardBody(el: HTMLElement, node: CardNode): Promise<void> {
    el.addClass("is-card");
    const meta = await readCard(this.app, {
      file: node.file,
      blockId: node.blockId,
      linkpath: "",
    });
    const body = el.createDiv({ cls: "volis-bnode-body" });

    if (meta.stale) {
      this.staleIds.add(node.id);
      body.createDiv({ cls: "volis-bnode-placeholder", text: "卡片已删除" });
      return;
    }

    this.nodeText.set(node.id, meta.editable);
    await MarkdownRenderer.render(this.app, normalizeTags(meta.body), body, node.file, this);
    this.decorateNumericTags(body);

    const parts: string[] = [];
    if (meta.date) parts.push(meta.date.slice(5));

    if (parts.length > 0) {
      el.createDiv({ cls: "volis-bnode-meta", text: parts.join("  ") });
    }
  }

  private async renderFileBody(el: HTMLElement, node: { id: string; file: string }): Promise<void> {
    el.addClass("is-file");
    const file = this.app.vault.getAbstractFileByPath(node.file);
    if (file instanceof TFile) this.nodeText.set(node.id, file.basename);

    if (!(file instanceof TFile)) {
      this.staleIds.add(node.id);
      el.createDiv({ cls: "volis-bnode-placeholder", text: "文件缺失" });
      return;
    }

    const src = this.app.vault.getResourcePath(file);
    const ext = file.extension.toLowerCase();

    if (ext === "md") {
      el.addClass("is-doc-text");
      el.createDiv({ cls: "volis-bnode-doc-head", text: file.basename });
      const body = el.createDiv({ cls: "volis-bnode-body volis-bnode-doc-body" });
      let content = "";
      try {
        content = await this.app.vault.cachedRead(file);
      } catch (error) {
        content = "";
      }
      if (content.trim()) {
        await MarkdownRenderer.render(this.app, content, body, file.path, this);
        this.decorateNumericTags(body);
      } else {
        body.createDiv({ cls: "volis-bnode-placeholder", text: "空笔记" });
      }
      return;
    }

    if (IMAGE_EXT.includes(ext)) {
      const img = el.createEl("img", { cls: "volis-bnode-media is-loading" });
      img.draggable = false;
      const reveal = () => img.removeClass("is-loading");
      img.addEventListener("load", reveal);
      img.addEventListener("error", reveal);
      img.src = src;
      if (img.complete) reveal();
      return;
    }

    if (ext === "pdf") {
      const embed = el.createEl("embed", { cls: "volis-bnode-media" });
      embed.setAttribute("src", src);
      embed.setAttribute("type", "application/pdf");
      return;
    }

    if (VIDEO_EXT.includes(ext)) {
      const video = el.createEl("video", { cls: "volis-bnode-media is-loading" });
      const revealVideo = () => video.removeClass("is-loading");
      video.addEventListener("loadeddata", revealVideo);
      video.addEventListener("error", revealVideo);
      video.src = src;
      video.muted = true;
      video.preload = "metadata";

      const play = el.createDiv({ cls: "volis-bnode-play" });
      play.addEventListener("pointerdown", (evt) => evt.stopPropagation());
      play.addEventListener("click", (evt) => {
        evt.stopPropagation();
        play.addClass("is-hidden");
        el.addClass("is-playing");
        video.controls = true;
        video.muted = false;
        void video.play();
      });
      return;
    }

    const audio = el.createEl("audio", { cls: "volis-bnode-media" });
    audio.src = src;
    audio.controls = false;

    const audioPlay = el.createDiv({ cls: "volis-bnode-play" });
    audioPlay.addEventListener("pointerdown", (evt) => evt.stopPropagation());
    audioPlay.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.openMedia(node.file);
    });
  }

  /**
   * Obsidian only treats a tag as such when it contains a non-digit character,
   * so `#09` renders as plain text. Numbered tags are common in this workflow,
   * so wrap them in the tag element after rendering. Code, links and existing
   * tags are left alone.
   */
  private decorateNumericTags(container: HTMLElement): void {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest("code, pre, a, .tag")) return NodeFilter.FILTER_REJECT;
        return /(^|\s)#\d+\b/.test(node.nodeValue ?? "")
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    const targets: Text[] = [];
    let current = walker.nextNode();
    while (current) {
      targets.push(current as Text);
      current = walker.nextNode();
    }

    for (const textNode of targets) {
      const text = textNode.nodeValue ?? "";
      const fragment = document.createDocumentFragment();
      const pattern = /(^|\s)(#\d+)\b/g;

      let last = 0;
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(text)) !== null) {
        const start = match.index + match[1].length;
        if (start > last) {
          fragment.appendChild(document.createTextNode(text.slice(last, start)));
        }

        // Obsidian renders tags as anchors and themes style `a.tag`.
        const tag = document.createElement("a");
        tag.className = "tag";
        tag.textContent = match[2];
        tag.setAttribute("href", match[2]);
        tag.addEventListener("click", (evt) => evt.preventDefault());
        fragment.appendChild(tag);

        last = start + match[2].length;
      }

      if (last === 0) continue;
      if (last < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(last)));
      }

      textNode.parentNode?.replaceChild(fragment, textNode);
    }
  }

  private applyTransform(): void {
    this.world.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;

    const gridSize = Math.max(MIN_GRID, GRID * this.scale);
    this.root.style.backgroundSize = `${gridSize}px ${gridSize}px`;
    this.root.style.backgroundPosition = `${this.tx}px ${this.ty}px`;

    this.zoomEl.setText(`${Math.round(this.scale * 100)}%`);
    this.updateToolbar();
    this.updateEdgeBar();
    this.updateMinimap();
  }

  private toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.root.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.tx) / this.scale,
      y: (clientY - rect.top - this.ty) / this.scale,
    };
  }

  private zoomBy(factor: number): void {
    const rect = this.root.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;

    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.scale * factor));
    if (next === this.scale) return;

    const ratio = next / this.scale;
    this.tx = cx - (cx - this.tx) * ratio;
    this.ty = cy - (cy - this.ty) * ratio;
    this.scale = next;

    this.applyTransform();
    this.scheduleSave();
  }

  private showBoardMenu(evt: MouseEvent): void {
    const menu = new Menu();
    const stale = this.staleIds.size;

    menu.addItem((item) =>
      item
        .setTitle("查找节点")
        .setIcon("search")
        .onClick(() => this.openNodeSearch())
    );

    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle(stale > 0 ? `清理失效节点（${stale}）` : "没有失效节点")
        .setIcon("eraser")
        .setDisabled(stale === 0)
        .onClick(() => this.cleanupStaleNodes())
    );

    const rect = this.moreBtn?.getBoundingClientRect();
    if (!rect) {
      menu.showAtMouseEvent(evt);
      return;
    }

    menu.showAtPosition({ x: Math.max(8, rect.right - 200), y: rect.bottom + 6 });

    // Realign horizontally once the menu knows its own width.
    const dom = (menu as unknown as { dom?: HTMLElement }).dom;
    if (dom) {
      dom.style.left = `${Math.max(8, Math.round(rect.right - dom.offsetWidth + 16))}px`;
      dom.style.top = `${Math.round(rect.bottom + 6)}px`;
    }
  }

  private cleanupStaleNodes(): void {
    if (this.hasEditingNode()) {
      new Notice("请先结束编辑再清理");
      return;
    }
    if (this.staleIds.size === 0) return;

    const ids = new Set(this.staleIds);
    this.nodes = this.nodes.filter((node) => !ids.has(node.id));

    for (const id of ids) {
      const el = this.nodeEls.get(id);
      if (el) el.remove();
      this.nodeEls.delete(id);
      this.nodeMap.delete(id);
      this.selection.delete(id);
    }

    this.staleIds.clear();
    this.updateFrame();
    this.updateHint();
    this.pushHistory();
    this.scheduleSave();
    new Notice(`已清理 ${ids.size} 个失效节点，可按 Ctrl+Z 撤销`);
  }

  private updateHistoryButtons(): void {
    if (this.undoBtn) this.undoBtn.disabled = this.historyIndex <= 0;
    if (this.redoBtn) this.redoBtn.disabled = this.historyIndex >= this.history.length - 1;
  }

  private fitToContent(): void {
    if (this.nodes.length === 0) {
      const empty = this.root.getBoundingClientRect();
      this.scale = 1;
      this.tx = empty.width / 2;
      this.ty = empty.height / 2;
      this.applyTransform();
      return;
    }

    const rect = this.root.getBoundingClientRect();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of this.nodes) {
      const el = this.nodeEls.get(node.id);
      const height = el?.offsetHeight ?? 120;
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + height);
    }

    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const scale = Math.min((rect.width - 120) / width, (rect.height - 120) / height, 1.2);

    this.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
    this.tx = rect.width / 2 - (minX + width / 2) * this.scale;
    this.ty = rect.height / 2 - (minY + height / 2) * this.scale;
    this.applyTransform();
  }

  private onKeyDown = (evt: KeyboardEvent): void => {
    const active = document.activeElement as HTMLElement | null;
    const inInput =
      !!active &&
      (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);

    if (evt.code === "Space" && !inInput) {
      this.spaceDown = true;
      this.root.addClass("is-space");
    }

    if (inInput) return;
    if (this.app.workspace.activeLeaf?.view !== this) return;

    const mod = evt.ctrlKey || evt.metaKey;
    const key = evt.key.toLowerCase();

    if (mod && key === "z") {
      evt.preventDefault();
      if (evt.shiftKey) void this.redo();
      else void this.undo();
      return;
    }

    if (mod && key === "y") {
      evt.preventDefault();
      void this.redo();
      return;
    }

    if (mod && key === "c") {
      evt.preventDefault();
      this.copySelection();
      return;
    }

    if (mod && key === "v") {
      evt.preventDefault();
      void this.pasteClipboard();
      return;
    }

    if (evt.key === "Delete" || evt.key === "Backspace") {
      if (this.selectedEdgeId) {
        evt.preventDefault();
        this.deleteSelectedEdge();
        return;
      }
      if (this.selection.size > 0) {
        evt.preventDefault();
        this.deleteSelection();
      }
    }
  };

  private onKeyUp = (evt: KeyboardEvent): void => {
    if (evt.code !== "Space") return;
    this.spaceDown = false;
    this.root.removeClass("is-space");
  };

  private onWheel = (evt: WheelEvent): void => {
    // While editing, the wheel belongs to the textarea's own scrollbar, not to
    // the board zoom.
    const target = evt.target as HTMLElement | null;
    if (target?.closest(".volis-inline")) return;
    if (target?.closest(".volis-insert-panel")) return;

    evt.preventDefault();

    if (evt.shiftKey) {
      this.tx -= evt.deltaY + evt.deltaX;
      this.applyTransform();
      this.scheduleSave();
      return;
    }

    const rect = this.root.getBoundingClientRect();
    const mx = evt.clientX - rect.left;
    const my = evt.clientY - rect.top;

    const factor = Math.exp(-evt.deltaY * 0.0015);
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.scale * factor));
    if (next === this.scale) return;

    const ratio = next / this.scale;
    this.tx = mx - (mx - this.tx) * ratio;
    this.ty = my - (my - this.ty) * ratio;
    this.scale = next;

    this.applyTransform();
    this.scheduleSave();
  };

  private onPointerDown = (evt: PointerEvent): void => {
    const target = evt.target as HTMLElement | null;
    if (!target) return;
    if (target.closest(".volis-board-toolbar")) return;

    const nodeEl = target.closest(".volis-bnode") as HTMLElement | null;
    const nodeId = nodeEl?.dataset?.nodeId ?? null;
    this.lastDownNodeId = nodeId;

    const portEl = target.closest(".volis-port") as HTMLElement | null;
    if (portEl && nodeId) {
      this.startLinkDrag(evt, nodeId, portEl.dataset.port ?? "right");
      return;
    }

    const handleEl = target.closest(".volis-resize-handle") as HTMLElement | null;
    if (handleEl && nodeId) {
      this.startResize(evt, nodeId, (handleEl.dataset.dir as ResizeDir) ?? "se");
      return;
    }

    if (target.closest(".volis-bnode.is-playing")) return;

    if (evt.button === 1 || (evt.button === 0 && this.spaceDown)) {
      evt.preventDefault();
      this.startPan(evt);
      return;
    }

    if (evt.button !== 0) return;

    if (nodeEl && nodeId) {
      // Remember whether it was already selected: a second click on an already
      // selected node opens the editor, the first click only selects it.
      this.pendingNodeClick = {
        id: nodeId,
        wasSelected: this.selection.has(nodeId),
        x: evt.clientX,
        y: evt.clientY,
      };
      this.startNodeDrag(evt, nodeId);
      return;
    }

    const worldPoint = this.toWorld(evt.clientX, evt.clientY);
    if (this.selection.size > 0 && this.isInsideFrame(worldPoint)) {
      this.beginNodeMove(evt);
      return;
    }

    this.startBoxSelect(evt);
  };

  private startResize(evt: PointerEvent, nodeId: string, dir: ResizeDir): void {
    const node = this.nodeMap.get(nodeId);
    const el = this.nodeEls.get(nodeId);
    if (!node || !el) return;

    evt.preventDefault();
    evt.stopPropagation();
    this.dragMoved = false;

    this.drag = {
      type: "resize",
      pointerId: evt.pointerId,
      nodeId,
      dir,
      startX: evt.clientX,
      startY: evt.clientY,
      start: { x: node.x, y: node.y, width: node.width, height: el.offsetHeight },
    };

    this.root.setPointerCapture(evt.pointerId);
    this.root.addClass("is-resizing");
  }

  /** Node whose box is within `slack` world units of the point. */
  private nodeNear(x: number, y: number, slack: number): BoardNode | null {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i];
      const height = this.nodeHeight(node);
      if (
        x >= node.x - slack &&
        x <= node.x + node.width + slack &&
        y >= node.y - slack &&
        y <= node.y + height + slack
      ) {
        return node;
      }
    }
    return null;
  }

  private closeSearchPanel(): void {
    if (this.searchOutside) {
      document.removeEventListener("mousedown", this.searchOutside, true);
      this.searchOutside = null;
    }
    this.searchPanel?.remove();
    this.searchPanel = null;
  }

  private centerOnNode(node: BoardNode): void {
    const rect = this.root.getBoundingClientRect();
    const height = this.nodeHeight(node);

    // Zoom so the node takes roughly a third of the viewport width.
    const fit = (rect.width * 0.33) / Math.max(1, node.width);
    this.scale = Math.max(0.6, Math.min(1.1, fit));

    this.tx = rect.width / 2 - (node.x + node.width / 2) * this.scale;
    this.ty = rect.height / 2 - (node.y + height / 2) * this.scale;

    this.applyTransform();
    this.scheduleSave();

    this.selection.clear();
    this.selection.add(node.id);
    this.paintSelection();

    const el = this.nodeEls.get(node.id);
    if (!el) return;

    // Dim everything else: contrast reads better than a highlight alone.
    for (const [id, other] of this.nodeEls) {
      other.toggleClass("is-dimmed", id !== node.id);
    }
    this.root.addClass("is-focusing");

    el.addClass("is-flash");

    window.setTimeout(() => {
      el.removeClass("is-flash");
      this.root.removeClass("is-focusing");
      for (const other of this.nodeEls.values()) other.removeClass("is-dimmed");
    }, 1600);
  }

  public openNodeSearch(): void {
    this.closeSearchPanel();

    const rect = this.root.getBoundingClientRect();
    const panel = this.root.createDiv({ cls: "volis-insert-panel" });
    const width = 328;
    const left = Math.max(8, (rect.width - width) / 2);
    const top = Math.max(48, rect.height * 0.22);

    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;

    panel.addEventListener("pointerdown", (evt) => evt.stopPropagation());
    panel.addEventListener("dblclick", (evt) => evt.stopPropagation());

    const head = panel.createDiv({ cls: "volis-insert-head" });
    const headIcon = head.createDiv({ cls: "volis-insert-head-icon" });
    setIcon(headIcon, "search");

    const input = head.createEl("input", {
      cls: "volis-insert-input",
      attr: { type: "text", placeholder: "在白板中查找节点…" },
    });

    const list = panel.createDiv({ cls: "volis-insert-list" });
    panel.createDiv({
      cls: "volis-insert-foot",
      text: "↑↓ 选择 · Enter 定位 · Esc 取消",
    });

    this.searchPanel = panel;

    const all = this.nodes;
    let results: BoardNode[] = [];
    let active = 0;

    const render = () => {
      list.empty();

      if (results.length === 0) {
        list.createDiv({ cls: "volis-insert-empty", text: "没有匹配的节点" });
        return;
      }

      results.forEach((node, index) => {
        const row = list.createDiv({ cls: "volis-insert-item" });
        if (index === active) {
          row.addClass("is-active");
          window.requestAnimationFrame(() => row.scrollIntoView({ block: "nearest" }));
        }

        const iconEl = row.createDiv({ cls: "volis-insert-item-icon" });
        setIcon(
          iconEl,
          node.type === "card"
            ? "list"
            : node.type === "group"
              ? "group"
              : node.type === "text"
                ? "type"
                : "file-text"
        );

        const body = row.createDiv({ cls: "volis-insert-item-body" });
        const text = (this.nodeText.get(node.id) ?? "").replace(/\s+/g, " ").trim();
        body.createDiv({
          cls: "volis-insert-title",
          text: text.slice(0, 48) || "（空节点）",
        });
        body.createDiv({
          cls: "volis-insert-sub",
          text:
            node.type === "card"
              ? "卡片"
              : node.type === "group"
                ? "分组"
                : node.type === "text"
                  ? "文本节点"
                  : node.file,
        });

        row.addEventListener("click", () => {
          this.closeSearchPanel();
          this.centerOnNode(node);
        });
      });
    };

    const search = (query: string) => {
      const q = query.trim().toLowerCase();
      results = q
        ? all.filter((node) => {
            const text = (this.nodeText.get(node.id) ?? "").toLowerCase();
            return text.includes(q);
          })
        : all.slice(0, 30);

      active = 0;
      render();
    };

    input.addEventListener("input", () => search(input.value));
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Escape") {
        evt.preventDefault();
        this.closeSearchPanel();
        return;
      }
      if (evt.key === "ArrowDown") {
        evt.preventDefault();
        active = Math.min(results.length - 1, active + 1);
        render();
        return;
      }
      if (evt.key === "ArrowUp") {
        evt.preventDefault();
        active = Math.max(0, active - 1);
        render();
        return;
      }
      if (evt.key === "Enter") {
        evt.preventDefault();
        const node = results[active];
        if (!node) return;
        this.closeSearchPanel();
        this.centerOnNode(node);
      }
    });

    this.searchOutside = (evt: MouseEvent) => {
      const target = evt.target as Node | null;
      if (target && panel.contains(target)) return;
      this.closeSearchPanel();
    };
    document.addEventListener("mousedown", this.searchOutside, true);

    search("");
    window.setTimeout(() => input.focus(), 20);
  }

  public openInsertPanelAtCenter(): void {
    const rect = this.root.getBoundingClientRect();
    const world = this.toWorld(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2
    );
    void this.openInsertPanel(world, null, null);
  }

  private closeInsertPanel(): void {
    if (this.panelOutside) {
      document.removeEventListener("mousedown", this.panelOutside, true);
      this.panelOutside = null;
    }
    if (this.insertPanel) {
      this.insertPanel.remove();
      this.insertPanel = null;
    }
  }

  private async openInsertPanel(
    world: { x: number; y: number },
    fromId: string | null,
    fromSide: PortSide | null
  ): Promise<void> {
    this.closeInsertPanel();

    const rect = this.root.getBoundingClientRect();
    const boxWidth = 320;
    const screenX = world.x * this.scale + this.tx;
    const screenY = world.y * this.scale + this.ty;

    const panel = this.root.createDiv({ cls: "volis-insert-panel" });
    panel.style.left = `${Math.round(Math.max(8, Math.min(screenX, rect.width - boxWidth - 8)))}px`;
    panel.style.top = `${Math.round(Math.max(8, Math.min(screenY, rect.height - 300)))}px`;

    panel.addEventListener("pointerdown", (evt) => evt.stopPropagation());
    panel.addEventListener("dblclick", (evt) => evt.stopPropagation());

    const head = panel.createDiv({ cls: "volis-insert-head" });
    const headIcon = head.createDiv({ cls: "volis-insert-head-icon" });
    setIcon(headIcon, "search");

    const input = head.createEl("input", {
      cls: "volis-insert-input",
      attr: { type: "text", placeholder: "搜索卡片、笔记，或新建…" },
    });

    const list = panel.createDiv({ cls: "volis-insert-list" });
    panel.createDiv({ cls: "volis-insert-foot", text: "↑↓ 选择 · Enter 确认 · Esc 取消" });

    this.insertPanel = panel;

    let items: InsertItem[] = [];
    let active = 0;
    let token = 0;

    const render = () => {
      list.empty();
      items.forEach((item, index) => {
        const row = list.createDiv({ cls: "volis-insert-item" });
        if (index === active) {
          row.addClass("is-active");
          window.requestAnimationFrame(() => {
            row.scrollIntoView({ block: "nearest" });
          });
        }

        const iconEl = row.createDiv({ cls: "volis-insert-item-icon" });
        setIcon(
          iconEl,
          item.kind === "card" ? "list" : item.kind === "note" ? "file-text" : "type"
        );

        const body = row.createDiv({ cls: "volis-insert-item-body" });
        body.createDiv({ cls: "volis-insert-title", text: item.title });
        body.createDiv({ cls: "volis-insert-sub", text: item.sub });

        row.addEventListener("click", () => void choose(index));
      });
    };

    const reload = async (query: string) => {
      const mine = ++token;
      const found = await searchInsertItems(this.app, this.plugin.settings.cardFolder, query);
      if (mine !== token || !this.insertPanel) return;
      items = found;
      active = 0;
      render();
    };

    const choose = async (index: number) => {
      const item = items[index];
      if (!item) return;
      this.closeInsertPanel();
      await this.applyInsert(item, world, fromId, fromSide);
    };

    input.addEventListener("input", () => void reload(input.value));
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Escape") {
        evt.preventDefault();
        this.closeInsertPanel();
        return;
      }
      if (evt.key === "ArrowDown") {
        evt.preventDefault();
        active = Math.min(items.length - 1, active + 1);
        render();
        return;
      }
      if (evt.key === "ArrowUp") {
        evt.preventDefault();
        active = Math.max(0, active - 1);
        render();
        return;
      }
      if (evt.key === "Enter") {
        evt.preventDefault();
        void choose(active);
      }
    });

    this.panelOutside = (evt: MouseEvent) => {
      if (!this.insertPanel) return;
      const target = evt.target as Node | null;
      if (target && panel.contains(target)) return;
      this.closeInsertPanel();
    };
    document.addEventListener("mousedown", this.panelOutside, true);

    await reload("");
    window.setTimeout(() => input.focus(), 20);
  }

  private async applyInsert(
    item: InsertItem,
    world: { x: number; y: number },
    fromId: string | null,
    fromSide: PortSide | null
  ): Promise<void> {
    let created: BoardNode | null = null;

    if (item.kind === "text") {
      created = await this.createTextNode(world);
    } else if (item.kind === "note") {
      const folder = this.plugin.settings.boardFolder ?? "";
      const file = await createNoteFromText(this.app, folder, "", "未命名");
      if (file) created = await this.addFileNode(file.path, world);
    } else if (item.kind === "card" && item.file && item.blockId) {
      created = await this.addCardNodeAt(
        item.file,
        item.blockId,
        Math.round(world.x - DEFAULT_CARD_WIDTH / 2),
        Math.round(world.y - 60),
        DEFAULT_CARD_WIDTH,
        320
      );
    }

    if (!fromId || !created) return;

    const target = this.nodeMap.get(created.id);
    const toSide = target ? this.nearestSide(target, world.x, world.y) : "left";

    this.edges.push({
      id: createId(),
      from: fromId,
      to: created.id,
      fromSide: fromSide ?? "right",
      toSide,
    });

    this.renderEdges();
    this.pushHistory();
    this.scheduleSave();
  }

  private nodeAt(x: number, y: number): BoardNode | null {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i];
      const height = this.nodeHeight(node);
      if (x >= node.x && x <= node.x + node.width && y >= node.y && y <= node.y + height) {
        return node;
      }
    }
    return null;
  }

  /**
   * Duplicate check is per port pair, not per node pair: two nodes can hold up
   * to sixteen distinct connections (4 sides x 4 sides).
   */
  private hasEdge(
    from: string,
    to: string,
    fromSide?: PortSide,
    toSide?: PortSide
  ): boolean {
    return this.edges.some(
      (edge) =>
        edge.from === from &&
        edge.to === to &&
        (edge.fromSide ?? null) === (fromSide ?? null) &&
        (edge.toSide ?? null) === (toSide ?? null)
    );
  }

  /**
   * Alignment snapping during a drag: compares the moving selection's six
   * anchor lines with every other node and pulls to the closest one within a
   * small screen-space threshold.
   */
  private computeSnap(
    initial: Map<string, { x: number; y: number }>,
    dx: number,
    dy: number
  ): { dx: number; dy: number; lines: GuideLine[] } {
    const moving = new Set(initial.keys());
    const threshold = 6 / this.scale;

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const [id, start] of initial) {
      const node = this.nodeMap.get(id);
      if (!node) continue;
      const height = this.nodeHeight(node);
      minX = Math.min(minX, start.x + dx);
      minY = Math.min(minY, start.y + dy);
      maxX = Math.max(maxX, start.x + dx + node.width);
      maxY = Math.max(maxY, start.y + dy + height);
    }

    if (!Number.isFinite(minX)) return { dx: 0, dy: 0, lines: [] };

    const anchorX = [minX, (minX + maxX) / 2, maxX];
    const anchorY = [minY, (minY + maxY) / 2, maxY];

    let bestDx = 0;
    let bestDy = 0;
    let distX = threshold;
    let distY = threshold;
    let lineX: GuideLine | null = null;
    let lineY: GuideLine | null = null;

    for (const other of this.nodes) {
      if (moving.has(other.id)) continue;

      const height = this.nodeHeight(other);
      const otherX = [other.x, other.x + other.width / 2, other.x + other.width];
      const otherY = [other.y, other.y + height / 2, other.y + height];

      for (const a of anchorX) {
        for (const b of otherX) {
          const delta = b - a;
          const distance = Math.abs(delta);
          if (distance < distX) {
            distX = distance;
            bestDx = delta;
            lineX = { axis: "x", pos: b };
          }
        }
      }

      for (const a of anchorY) {
        for (const b of otherY) {
          const delta = b - a;
          const distance = Math.abs(delta);
          if (distance < distY) {
            distY = distance;
            bestDy = delta;
            lineY = { axis: "y", pos: b };
          }
        }
      }
    }

    const lines: GuideLine[] = [];
    if (lineX) lines.push(lineX);
    if (lineY) lines.push(lineY);

    return { dx: bestDx, dy: bestDy, lines };
  }

  private drawGuides(lines: GuideLine[]): void {
    const svg = this.edgesEl;
    if (!svg || lines.length === 0) return;

    const box = svg.viewBox.baseVal;
    const left = box.x;
    const top = box.y;
    const right = box.x + box.width;
    const bottom = box.y + box.height;

    for (const guide of lines) {
      const line = this.svgNode("line");

      if (guide.axis === "x") {
        line.setAttribute("x1", String(guide.pos));
        line.setAttribute("y1", String(top));
        line.setAttribute("x2", String(guide.pos));
        line.setAttribute("y2", String(bottom));
      } else {
        line.setAttribute("x1", String(left));
        line.setAttribute("y1", String(guide.pos));
        line.setAttribute("x2", String(right));
        line.setAttribute("y2", String(guide.pos));
      }

      line.setAttribute("class", "volis-guide");
      svg.appendChild(line);
    }
  }

  private setLinkTarget(nodeId: string | null): void {
    for (const [id, el] of this.nodeEls) {
      el.toggleClass("is-link-target", id === nodeId);
    }
  }

  private startLinkDrag(evt: PointerEvent, fromId: string, side: string): void {
    evt.preventDefault();
    evt.stopPropagation();

    if (!this.edgesEl) return;

    const from = this.nodeMap.get(fromId);
    if (!from) return;

    const height = this.nodeHeight(from);
    const anchor =
      side === "top"
        ? { x: from.x + from.width / 2, y: from.y }
        : side === "bottom"
          ? { x: from.x + from.width / 2, y: from.y + height }
          : side === "left"
            ? { x: from.x, y: from.y + height / 2 }
            : { x: from.x + from.width, y: from.y + height / 2 };

    const preview = this.svgNode("path");
    preview.setAttribute("class", "volis-edge is-preview");
    this.edgesEl.appendChild(preview);

    this.setLinkTarget(null);

    this.linkDrag = {
      fromId,
      pointerId: evt.pointerId,
      path: preview,
      anchor,
      side: side as PortSide,
    };
    this.root.setPointerCapture(evt.pointerId);
    this.root.addClass("is-linking");
  }

  private updateLinkDrag(evt: PointerEvent): void {
    const drag = this.linkDrag;
    if (!drag) return;

    const world = this.toWorld(evt.clientX, evt.clientY);

    const hit = document.elementFromPoint(evt.clientX, evt.clientY) as HTMLElement | null;
    let hovered = hit?.closest(".volis-bnode")?.getAttribute("data-node-id") ?? null;
    if (!hovered) {
      const near = this.nodeNear(world.x, world.y, 24 / this.scale);
      hovered = near?.id ?? null;
    }
    if (hovered === drag.fromId) hovered = null;
    this.setLinkTarget(hovered);

    const normal = this.sideNormal(drag.side);
    const dist = Math.hypot(world.x - drag.anchor.x, world.y - drag.anchor.y);
    const offset = Math.max(28, Math.min(150, dist * 0.35));
    const c1 = {
      x: drag.anchor.x + normal.x * offset,
      y: drag.anchor.y + normal.y * offset,
    };

    drag.path.setAttribute(
      "d",
      `M ${drag.anchor.x} ${drag.anchor.y} C ${c1.x} ${c1.y}, ${world.x} ${world.y}, ${world.x} ${world.y}`
    );
  }

  private finishLinkDrag(evt: PointerEvent): void {
    const drag = this.linkDrag;
    if (!drag) return;

    this.linkDrag = null;
    this.setLinkTarget(null);
    drag.path.remove();
    this.root.removeClass("is-linking");

    try {
      this.root.releasePointerCapture(evt.pointerId);
    } catch (error) {
      // already released
    }

    const hit = document.elementFromPoint(evt.clientX, evt.clientY) as HTMLElement | null;
    const nodeEl = hit?.closest(".volis-bnode") as HTMLElement | null;
    const portSide = (hit?.closest(".volis-port") as HTMLElement | null)?.dataset.port ?? null;

    const world = this.toWorld(evt.clientX, evt.clientY);
    let targetId = nodeEl?.getAttribute("data-node-id") ?? null;

    if (!targetId) {
      const nearby = this.nodeNear(world.x, world.y, 24 / this.scale);
      if (nearby) targetId = nearby.id;
    }

    if (!targetId || targetId === drag.fromId) {
      void this.openInsertPanel(
        this.toWorld(evt.clientX, evt.clientY),
        drag.fromId,
        drag.side
      );
      return;
    }

    const target = this.nodeMap.get(targetId);
    if (!target) return;
    const toSide = (portSide as PortSide | null) ?? this.nearestSide(target, world.x, world.y);

    if (this.hasEdge(drag.fromId, targetId, drag.side, toSide)) return;

    this.edges.push({
      id: createId(),
      from: drag.fromId,
      to: targetId,
      fromSide: drag.side,
      toSide,
    });
    this.renderEdges();
    this.pushHistory();
    this.scheduleSave();
  }

  private buildEdgeBar(): void {
    const bar = this.edgeBar;
    if (!bar) return;

    bar.empty();

    for (const color of NODE_COLORS) {
      const dot = bar.createEl("button", {
        cls: "volis-edge-dot",
        attr: { "aria-label": color.label },
      });
      dot.style.background = color.line;
      dot.addEventListener("click", () => this.styleSelectedEdge({ color: color.name }));
    }

    const picker = bar.createEl("label", {
      cls: "volis-edge-dot is-custom",
      attr: { "aria-label": "自定义颜色" },
    });
    const input = picker.createEl("input", { attr: { type: "color" } });
    input.value = "#888888";
    input.addEventListener("change", () => this.styleSelectedEdge({ color: input.value }));

    bar.createDiv({ cls: "volis-edge-sep" });

    const arrowBtn = (arrow: "target" | "both" | "none", icon: string, label: string) => {
      const button = bar.createEl("button", {
        cls: "volis-tool-btn",
        attr: { "aria-label": label },
      });
      setIcon(button, icon);
      button.addEventListener("click", () => this.styleSelectedEdge({ arrow }));
    };

    arrowBtn("target", "arrow-right", "单向箭头");
    arrowBtn("both", "arrow-left-right", "双向箭头");
    arrowBtn("none", "minus", "无箭头");

    bar.createDiv({ cls: "volis-edge-sep" });

    const remove = bar.createEl("button", {
      cls: "volis-tool-btn is-danger",
      attr: { "aria-label": "删除连线" },
    });
    setIcon(remove, "trash-2");
    remove.addEventListener("click", () => this.deleteSelectedEdge());
  }

  private styleSelectedEdge(patch: { color?: string; arrow?: "target" | "both" | "none" }): void {
    const edge = this.edges.find((item) => item.id === this.selectedEdgeId);
    if (!edge) return;

    if (patch.color !== undefined) edge.color = patch.color;
    if (patch.arrow !== undefined) edge.arrow = patch.arrow;

    this.renderEdges();
    this.updateEdgeBar();
    this.pushHistory();
    this.scheduleSave();
  }

  private updateEdgeBar(): void {
    const bar = this.edgeBar;
    if (!bar) return;

    if (!this.selectedEdgeId) {
      bar.addClass("is-hidden");
      return;
    }

    const edge = this.edges.find((item) => item.id === this.selectedEdgeId);
    if (!edge) {
      bar.addClass("is-hidden");
      return;
    }

    if (!bar.hasChildNodes()) this.buildEdgeBar();
    bar.removeClass("is-hidden");

    const rect = this.root.getBoundingClientRect();
    const path = this.edgesEl?.querySelector(
      `[data-edge-id="${edge.id}"] .volis-edge`
    ) as SVGPathElement | null;

    let mid = { x: 0, y: 0 };
    if (path) {
      const point = path.getPointAtLength(path.getTotalLength() / 2);
      mid = { x: point.x, y: point.y };
    }

    const screenX = mid.x * this.scale + this.tx;
    const screenY = mid.y * this.scale + this.ty;

    const width = bar.offsetWidth || 240;
    const height = bar.offsetHeight || 36;

    const left = Math.max(8, Math.min(screenX - width / 2, rect.width - width - 8));
    const top = Math.max(8, screenY - height - 12);

    bar.style.left = `${Math.round(left)}px`;
    bar.style.top = `${Math.round(top)}px`;
  }

  private selectEdge(edgeId: string): void {
    this.selectedEdgeId = edgeId;
    this.selection.clear();
    this.paintSelection();
    this.renderEdges();
    this.updateEdgeBar();
  }

  private deleteSelectedEdge(): boolean {
    if (!this.selectedEdgeId) return false;

    this.edges = this.edges.filter((edge) => edge.id !== this.selectedEdgeId);
    this.selectedEdgeId = null;
    this.updateEdgeBar();
    this.renderEdges();
    this.pushHistory();
    this.scheduleSave();
    return true;
  }

  private bringToFront(nodeId: string): void {
    const el = this.nodeEls.get(nodeId);
    if (!el) return;
    // The selection frame must stay underneath, so nodes go to the very end.
    this.world.appendChild(el);
  }

  private startNodeDrag(evt: PointerEvent, nodeId: string): void {
    const additive = evt.ctrlKey || evt.metaKey || evt.shiftKey;

    if (additive) {
      if (this.selection.has(nodeId)) this.selection.delete(nodeId);
      else this.selection.add(nodeId);
    } else if (!this.selection.has(nodeId)) {
      this.selection.clear();
      this.selection.add(nodeId);
    }

    this.paintSelection();
    if (!this.selection.has(nodeId)) return;

    this.bringToFront(nodeId);
    this.dragMoved = false;
    this.beginNodeMove(evt);
  }

  private beginNodeMove(evt: PointerEvent): void {
    const initial = new Map<string, { x: number; y: number }>();

    for (const id of this.selection) {
      const node = this.nodeMap.get(id);
      if (!node) continue;

      initial.set(node.id, { x: node.x, y: node.y });

      if (node.type === "group") {
        for (const member of this.groupMembers(node)) {
          if (!initial.has(member.id)) {
            initial.set(member.id, { x: member.x, y: member.y });
          }
        }
      }
    }

    if (initial.size === 0) return;

    this.drag = {
      type: "node",
      pointerId: evt.pointerId,
      startWorld: this.toWorld(evt.clientX, evt.clientY),
      initial,
    };
    this.root.setPointerCapture(evt.pointerId);
    this.root.addClass("is-dragging-node");
  }

  private startPan(evt: PointerEvent): void {
    this.drag = {
      type: "pan",
      pointerId: evt.pointerId,
      startClient: { x: evt.clientX, y: evt.clientY },
      startView: { tx: this.tx, ty: this.ty },
    };
    this.root.setPointerCapture(evt.pointerId);
    this.root.addClass("is-panning");
  }

  private stopAllPlayback(): void {
    this.world.querySelectorAll(".volis-bnode.is-playing").forEach((element) => {
      const el = element as HTMLElement;
      el.removeClass("is-playing");
      const video = el.querySelector("video");
      if (video) {
        video.pause();
        video.controls = false;
      }
      const play = el.querySelector(".volis-bnode-play") as HTMLElement | null;
      if (play) play.removeClass("is-hidden");
    });
  }

  private clearBox(): void {
    if (this.boxEl) {
      this.boxEl.remove();
      this.boxEl = null;
    }
    this.boxStart = null;
  }

  private startBoxSelect(evt: PointerEvent): void {
    this.clearBox();
    this.stopAllPlayback();

    if (this.selectedEdgeId) {
      this.selectedEdgeId = null;
      this.renderEdges();
      this.updateEdgeBar();
    }
    if (!evt.ctrlKey && !evt.metaKey && !evt.shiftKey) {
      this.selection.clear();
      this.paintSelection();
    }

    const rect = this.root.getBoundingClientRect();
    this.boxStart = { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
    this.boxEl = this.root.createDiv({ cls: "volis-select-box" });
    this.boxEl.style.left = `${this.boxStart.x}px`;
    this.boxEl.style.top = `${this.boxStart.y}px`;

    this.drag = { type: "box", pointerId: evt.pointerId };
    this.root.setPointerCapture(evt.pointerId);
  }

  private updateBox(evt: PointerEvent): void {
    if (!this.boxEl || !this.boxStart) return;

    const rect = this.root.getBoundingClientRect();
    const cx = evt.clientX - rect.left;
    const cy = evt.clientY - rect.top;

    const left = Math.min(this.boxStart.x, cx);
    const top = Math.min(this.boxStart.y, cy);
    const width = Math.abs(cx - this.boxStart.x);
    const height = Math.abs(cy - this.boxStart.y);

    this.boxEl.style.left = `${left}px`;
    this.boxEl.style.top = `${top}px`;
    this.boxEl.style.width = `${width}px`;
    this.boxEl.style.height = `${height}px`;

    const wx1 = (left - this.tx) / this.scale;
    const wy1 = (top - this.ty) / this.scale;
    const wx2 = (left + width - this.tx) / this.scale;
    const wy2 = (top + height - this.ty) / this.scale;

    this.selection.clear();
    for (const node of this.nodes) {
      const el = this.nodeEls.get(node.id);
      const nh = el?.offsetHeight ?? 100;
      if (node.x > wx2 || node.x + node.width < wx1) continue;
      if (node.y > wy2 || node.y + nh < wy1) continue;
      this.selection.add(node.id);
    }
    this.paintSelection();
  }

  private onPointerMove = (evt: PointerEvent): void => {
    this.lastPointerWorld = this.toWorld(evt.clientX, evt.clientY);

    if (this.linkDrag && this.linkDrag.pointerId === evt.pointerId) {
      this.updateLinkDrag(evt);
      return;
    }

    const drag = this.drag;
    if (!drag || drag.pointerId !== evt.pointerId) return;

    if (drag.type === "pan") {
      this.tx = drag.startView.tx + (evt.clientX - drag.startClient.x);
      this.ty = drag.startView.ty + (evt.clientY - drag.startClient.y);
      this.applyTransform();
      return;
    }

    if (drag.type === "box") {
      this.updateBox(evt);
      return;
    }

    if (drag.type === "resize") {
      const node = this.nodeMap.get(drag.nodeId);
      const el = this.nodeEls.get(drag.nodeId);
      if (!node || !el) return;

      const dx = (evt.clientX - drag.startX) / this.scale;
      const dy = (evt.clientY - drag.startY) / this.scale;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) this.dragMoved = true;

      const dir = drag.dir;
      const MIN_W = 160;
      const MIN_H = 80;

      let x = drag.start.x;
      let y = drag.start.y;
      let width = drag.start.width;
      let height = drag.start.height;

      if (dir.includes("e")) width = drag.start.width + dx;
      if (dir.includes("s")) height = drag.start.height + dy;
      if (dir.includes("w")) {
        width = drag.start.width - dx;
        x = drag.start.x + dx;
      }
      if (dir.includes("n")) {
        height = drag.start.height - dy;
        y = drag.start.y + dy;
      }

      if (width < MIN_W) {
        if (dir.includes("w")) x -= MIN_W - width;
        width = MIN_W;
      }
      if (height < MIN_H) {
        if (dir.includes("n")) y -= MIN_H - height;
        height = MIN_H;
      }

      node.x = Math.round(x);
      node.y = Math.round(y);
      node.width = Math.round(width);
      node.height = Math.round(height);

      el.style.width = `${node.width}px`;
      el.style.height = `${node.height}px`;
      el.style.transform = `translate3d(${node.x}px, ${node.y}px, 0)`;

      this.renderEdges();
      this.updateFrame();
      return;
    }

    const point = this.toWorld(evt.clientX, evt.clientY);
    let dx = point.x - drag.startWorld.x;
    let dy = point.y - drag.startWorld.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this.dragMoved = true;

    let guides: GuideLine[] = [];
    if (!evt.altKey) {
      const snap = this.computeSnap(drag.initial, dx, dy);
      dx += snap.dx;
      dy += snap.dy;
      guides = snap.lines;
    }

    for (const [id, initial] of drag.initial) {
      const node = this.nodeMap.get(id);
      const el = this.nodeEls.get(id);
      if (!node || !el) continue;
      node.x = Math.round(initial.x + dx);
      node.y = Math.round(initial.y + dy);
      el.style.transform = `translate3d(${node.x}px, ${node.y}px, 0)`;
    }
    this.renderEdges();
    this.drawGuides(guides);
    this.updateFrame();
  };

  private onPointerUp = (evt: PointerEvent): void => {
    if (this.linkDrag && this.linkDrag.pointerId === evt.pointerId) {
      this.finishLinkDrag(evt);
      this.clearBox();
      return;
    }

    if (!this.drag || this.drag.pointerId !== evt.pointerId) {
      this.clearBox();
      return;
    }

    const pendingClick = this.pendingNodeClick;
    this.pendingNodeClick = null;

    const wasBox = this.drag.type === "box";
    const wasResize = this.drag.type === "resize";
    this.drag = null;
    this.root.removeClass("is-panning");
    this.root.removeClass("is-dragging-node");
    this.root.removeClass("is-resizing");

    if (wasBox) this.clearBox();

    try {
      this.root.releasePointerCapture(evt.pointerId);
    } catch (error) {
      // already released
    }

    const didMove = this.dragMoved;
    this.dragMoved = false;

    if (wasBox) return;
    if (wasResize || didMove) this.pushHistory();
    if (didMove) this.renderEdges();
    this.scheduleSave();

    if (!pendingClick || !pendingClick.wasSelected) return;

    const distance = Math.hypot(evt.clientX - pendingClick.x, evt.clientY - pendingClick.y);
    if (distance > 6) return;

    const node = this.nodeMap.get(pendingClick.id);
    if (node) this.activateNode(node);
  };

  private activateNode(node: BoardNode): void {
    if (node.type === "group") return;

    if (node.type === "file") {
      const file = this.app.vault.getAbstractFileByPath(node.file);
      if (file instanceof TFile && file.extension.toLowerCase() === "md") {
        void this.openEditor(node);
      }
      // media nodes keep the double-click gesture, a single click would be too
      // easy to trigger by accident.
      return;
    }
    void this.openEditor(node);
  }

  private paintSelection(): void {
    for (const [id, el] of this.nodeEls) {
      el.toggleClass("is-selected", this.selection.has(id));
    }
    this.updateFrame();
  }

  private updateFrame(): void {
    this.updateToolbar();

    const frame = this.frameEl;
    if (!frame) return;

    if (this.selection.size <= 1) {
      frame.addClass("is-hidden");
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const id of this.selection) {
      const node = this.nodeMap.get(id);
      if (!node) continue;
      const el = this.nodeEls.get(id);
      const height = el?.offsetHeight ?? 100;
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + height);
    }

    if (!Number.isFinite(minX)) {
      frame.addClass("is-hidden");
      return;
    }

    frame.removeClass("is-hidden");
    frame.style.left = `${minX}px`;
    frame.style.top = `${minY}px`;
    frame.style.width = `${maxX - minX}px`;
    frame.style.height = `${maxY - minY}px`;
  }

  private isInsideFrame(point: { x: number; y: number }): boolean {
    const frame = this.frameEl;
    if (!frame || frame.hasClass("is-hidden")) return false;

    const x = parseFloat(frame.style.left) || 0;
    const y = parseFloat(frame.style.top) || 0;
    const w = parseFloat(frame.style.width) || 0;
    const h = parseFloat(frame.style.height) || 0;

    return point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h;
  }

  private onDoubleClick = (evt: MouseEvent): void => {
    const target = evt.target as HTMLElement | null;
    if (!target) return;
    if (target.closest(".volis-board-toolbar")) return;

    // Pointer capture rewrites the target of click/dblclick to the capture
    // element, so trust the node recorded on pointerdown instead.
    const nodeId = this.lastDownNodeId ?? target.closest(".volis-bnode")?.getAttribute("data-node-id") ?? null;

    if (nodeId) {
      const node = this.nodeMap.get(nodeId);
      if (!node) return;
      if (node.type === "file") {
        const file = this.app.vault.getAbstractFileByPath(node.file);
        if (file instanceof TFile && file.extension.toLowerCase() === "md") {
          void this.openEditor(node);
          return;
        }
        this.openMedia(node.file);
        return;
      }
      void this.openEditor(node);
      return;
    }

    void this.createTextNode(this.toWorld(evt.clientX, evt.clientY));
  };

  private openMedia(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) new MediaModal(this.app, file).open();
  }

  private async createTextNode(point: { x: number; y: number }): Promise<TextNode> {
    const node: TextNode = {
      id: createId(),
      type: "text",
      text: "",
      x: Math.round(point.x - DEFAULT_CARD_WIDTH / 2),
      y: Math.round(point.y - 24),
      width: DEFAULT_CARD_WIDTH,
    };

    this.nodes.push(node);
    this.nodeMap.set(node.id, node);

    const el = await this.renderNode(node);
    this.selection.clear();
    this.selection.add(node.id);
    this.paintSelection();
    this.updateHint();
    this.pushHistory();
    this.openEditor(node, el);
    return node;
  }

  private async openEditor(node: BoardNode, existingEl?: HTMLElement): Promise<void> {
    const el = existingEl ?? this.nodeEls.get(node.id);
    if (!el) return;
    if (el.hasClass("volis-editing")) return;

    const restoreBar = () => window.setTimeout(() => this.updateToolbar(), 0);

    if (node.type === "text") {
      new InlineEditor(
        el,
        node.text,
        async (value) => {
          const current = this.nodeMap.get(node.id);
          if (!current || current.type !== "text") return;
          current.text = value;
          await this.renderNode(current);
          this.scheduleSave();
        },
        () => undefined,
        undefined,
        restoreBar
      );
      return;
    }

    if (node.type === "card") {
      const meta = await readCard(this.app, {
        file: node.file,
        blockId: node.blockId,
        linkpath: "",
      });
      if (meta.stale) return;

      new InlineEditor(
        el,
        meta.editable,
        async (value) => {
          if (!value.trim()) return;
          const ok = await writeCard(this.app, meta.ref, meta.timePrefix + value);
          if (ok) {
            const current = this.nodeMap.get(node.id);
            if (current && current.type === "card") {
              await this.renderNode(current);
            }
            this.scheduleSave();
          }
        },
        () => undefined,
        undefined,
        restoreBar
      );
      return;
    }

    if (node.type === "file") {
      const file = this.app.vault.getAbstractFileByPath(node.file);
      if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") return;

      const content = await this.app.vault.read(file);

      new MarkdownNodeEditor(
        this.app,
        el,
        file,
        content,
        async (target, body) => {
          const current = this.nodeMap.get(node.id);
          if (!current || current.type !== "file") return;

          if (body !== content) {
            await this.app.vault.modify(target, body);
          }
          current.file = target.path;
          await this.renderNode(current);
          this.scheduleSave();
        },
        () => undefined,
        restoreBar
      );
    }
  }

  private onDragOver = (evt: DragEvent): void => {
    evt.preventDefault();
    if (evt.dataTransfer) evt.dataTransfer.dropEffect = "copy";
    this.root.addClass("is-drop-target");
  };

  private onDragLeave = (evt: DragEvent): void => {
    const related = evt.relatedTarget as Node | null;
    if (related && this.root.contains(related)) return;
    this.root.removeClass("is-drop-target");
  };

  private onDrop = async (evt: DragEvent): Promise<void> => {
    evt.preventDefault();
    this.root.removeClass("is-drop-target");

    const point = this.toWorld(evt.clientX, evt.clientY);
    const dt = evt.dataTransfer;
    if (!dt) return;

    const plain = dt.getData("text/plain") ?? "";
    const uri = (dt.getData("text/uri-list") ?? "").split(/\r?\n/)[0] ?? "";

    const block = plain.match(/!?\[\[([^\[\]|#]+)#\^([^\]|\n]+)(?:\|[^\]\n]+)?\]\]/);
    if (block) {
      const dest = this.app.metadataCache.getFirstLinkpathDest(block[1].trim(), "");
      if (dest) {
        await this.addCardNode(dest.path, block[2].trim(), point);
        return;
      }
    }

    if (uri) {
      const resolved = this.resolveUri(uri);
      if (resolved) {
        await this.addFileNode(resolved, point);
        return;
      }
    }

    // Exact vault path only: resolving a bare file name here would match an
    // unrelated note and skip importing the file the user actually dropped.
    const candidate = plain.trim();
    if (candidate) {
      const direct = this.app.vault.getAbstractFileByPath(candidate);
      if (direct instanceof TFile) {
        await this.addFileNode(direct.path, point);
        return;
      }
    }

    const dropped = Array.from(dt.files ?? []);
    if (dropped.length > 0) {
      const basePath = String((this.app.vault.adapter as any).basePath ?? "").replace(/\\/g, "/");
      let handled = false;

      for (const item of dropped) {
        const raw = (item as File & { path?: string }).path;
        if (raw) {
          const full = raw.replace(/\\/g, "/");
          const rel = basePath && full.startsWith(basePath)
            ? full.slice(basePath.length).replace(/^\//, "")
            : "";
          if (rel) {
            const inside = this.app.vault.getAbstractFileByPath(rel);
            if (inside instanceof TFile) {
              await this.addFileNode(inside.path, point);
              handled = true;
              continue;
            }
          }
        }

        const imported = await this.importExternalFile(item);
        if (imported) {
          await this.addFileNode(imported, point);
          handled = true;
        }
      }

      if (handled) return;
    }
  };

  private async importExternalFile(file: File): Promise<string | null> {
    try {
      const buffer = await file.arrayBuffer();

      const config = (this.app.vault as any).getConfig?.("attachmentFolderPath");
      let dir = typeof config === "string" ? config : "Attachments";
      if (dir === "/" || dir === "./") dir = "";
      dir = dir.replace(/^\.\//, "").replace(/\/$/, "");

      if (dir && !(await this.app.vault.adapter.exists(dir))) {
        try {
          await this.app.vault.createFolder(dir);
        } catch (error) {
          // folder may already exist
        }
      }

      const dot = file.name.lastIndexOf(".");
      const base = dot > 0 ? file.name.slice(0, dot) : file.name;
      const ext = dot > 0 ? file.name.slice(dot) : "";

      let name = file.name;
      let path = dir ? `${dir}/${name}` : name;
      let index = 1;

      while (await this.app.vault.adapter.exists(path)) {
        name = `${base} ${index}${ext}`;
        path = dir ? `${dir}/${name}` : name;
        index += 1;
      }

      await this.app.vault.createBinary(path, buffer);
      return path;
    } catch (error) {
      console.error("[Volis] import file failed", error);
      return null;
    }
  }

  private resolveUri(uri: string): string | null {
    try {
      const url = new URL(uri);
      if (!url.protocol.startsWith("obsidian")) return null;
      const file = url.searchParams.get("file");
      if (!file) return null;
      const dest = this.app.metadataCache.getFirstLinkpathDest(file, "");
      return dest ? dest.path : null;
    } catch (error) {
      return null;
    }
  }

  private async addCardNode(
    file: string,
    blockId: string,
    point: { x: number; y: number }
  ): Promise<void> {
    const node: CardNode = {
      id: createId(),
      type: "card",
      file,
      blockId,
      x: Math.round(point.x - DEFAULT_CARD_WIDTH / 2),
      y: Math.round(point.y - 60),
      width: DEFAULT_CARD_WIDTH,
    };

    this.nodes.push(node);
    this.nodeMap.set(node.id, node);
    await this.renderNode(node);
    this.updateHint();
    this.pushHistory();
    this.scheduleSave();
  }

  private async addFileNode(file: string, point: { x: number; y: number }): Promise<FileNode> {
    const target = this.app.vault.getAbstractFileByPath(file);
    const width = DEFAULT_FILE_WIDTH;
    const ext = target instanceof TFile ? target.extension.toLowerCase() : "";
    const isImage = IMAGE_EXT.includes(ext);
    const isNote = ext === "md";

    const node = {
      id: createId(),
      type: "file" as const,
      file,
      x: Math.round(point.x - width / 2),
      y: Math.round(point.y - 100),
      width,
      height: isImage ? 240 : isNote ? 320 : undefined,
    };

    this.nodes.push(node);
    this.nodeMap.set(node.id, node);
    await this.renderNode(node);
    this.updateHint();
    this.pushHistory();
    this.scheduleSave();
    return node;
  }

  private scheduleSave(): void {
    if (!this.loaded) return;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.requestSave();
    }, 500);
  }

  private serialize(): BoardData {
    return {
      version: 1,
      edges: this.edges,
      nodes: this.nodes.map((node) => ({
        ...node,
        x: Math.round(node.x),
        y: Math.round(node.y),
      })),
      viewport: {
        tx: Math.round(this.tx),
        ty: Math.round(this.ty),
        scale: Number(this.scale.toFixed(3)),
      },
    };
  }
}

function createId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Markdown only treats `#tag` as a tag when it follows whitespace, but the
 * card plugin happily writes `…人群。#产品`. Insert a space before rendering so
 * the tag shows up here the same way it does in the sidebar. Render-only: the
 * stored text is never touched.
 */
function normalizeTags(text: string): string {
  return text.replace(/([^\s#\w])#([\p{L}\p{N}_/-]+)/gu, "$1 #$2");
}
