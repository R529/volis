import { MarkdownRenderer, Menu, Notice, TFile, TextFileView, WorkspaceLeaf, setIcon } from "obsidian";
import type VolisPlugin from "../main";
import { readCard, writeCard } from "../store/cardStore";
import { InlineEditor } from "../ui/inlineEditor";
import { MarkdownNodeEditor } from "../ui/markdownNodeEditor";
import { MediaModal } from "../ui/mediaModal";
import { RenameModal } from "../ui/renameModal";
import { ConfirmModal } from "../ui/confirmModal";
import { appendCard, createNoteFromText, resolveCardFolder } from "./cardWriter";
import {
  AIProvider,
  AIMessage,
  AIResult,
  AISystemBlock,
  balanceTail,
  createProvider,
  isThinkingBudgetError,
  mergeContinuation,
} from "../ai/provider";
import {
  activeProfile,
  AISendSnapshot,
  AIProfile,
  AIThinkingMode,
  StoredConversation,
} from "../settings";
import {
  buildBoardContext,
  ContextEdgeInput,
  ContextGroupInput,
  ContextNodeInput,
  estimateTokens,
  SendManifest,
} from "../ai/context";
import { formatTokens } from "../ai/capability";
import { InsertFilter, InsertItem, searchInsertItems } from "./insertSearch";
import { clampLabelT, Curve, curvePath, curvePoint, nearestCurveT, Point } from "./curve";
import {
  doctorNodeName,
  DoctorInput,
  DoctorIssue,
  scanBoard,
} from "./doctor";
import { BoardDoctorModal, DoctorActions } from "../ui/doctorModal";
import { ShortcutHelpModal } from "../ui/shortcutHelpModal";
import {
  BoardData,
  BoardEdge,
  BoardNode,
  EdgeRelation,
  PortSide,
  CardNode,
  DEFAULT_CARD_WIDTH,
  DEFAULT_FILE_WIDTH,
  FileNode,
  GroupNode,
  TextNode,
} from "./types";
import { EDGE_RELATIONS, EDGE_RELATION_BY_ID } from "./relations";
import { buildOutline } from "./outline";
import type { OutlineInfo, OutlineItem, OutlineNodeInput, OutlineResult } from "./outline";
import { buildExportMarkdown } from "./markdownExport";
import type { ExportNodeInfo } from "./markdownExport";
import { MarkdownExportModal } from "../ui/exportModal";

export const VIEW_TYPE_VOLIS_BOARD = "volis-board";

const GRID = 24;
const MIN_GRID = 10;
/** Connection labels are a glanceable hint, not a paragraph: cap them so a
 *  pasted sentence cannot stretch across the board. */
const EDGE_LABEL_MAX = 40;

/** Label chip metrics, in board units: the chip scales with the board just
 *  like the stroke does, so these are world-space numbers, not screen pixels. */
const EDGE_LABEL_FONT_SIZE = 17;
const EDGE_LABEL_PAD_X = 12;
const EDGE_LABEL_HEIGHT = 32;
const EDGE_LABEL_RADIUS = 10;

/** An edge's curve plus the path text drawn for it. */
type EdgeCurve = Curve & { d: string };
const MIN_SCALE = 0.05;
const MAX_SCALE = 3;
const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];
const VIDEO_EXT = ["mp4", "webm", "mov", "mkv"];

/** Continues a capped answer; the round limit lives in settings. */
const CONTINUE_PROMPT =
  "你上一条回答因为长度上限被截断了。请从断掉的地方直接往下接着写，" +
  "不要重复已经写过的内容，不要开场白，不要解释，只输出续写的部分。";

/** The stable half of the prompt. Kept separate so it can be cached. */
const AI_ROLE_PROMPT =
  "你是白板整理助手。用户给你白板上的节点内容和它们之间的关系，请用简洁的中文回答，" +
  "不要复述原文，直接给判断和建议。必要时用列表。" +
  "如果上下文里说明某些节点没有发送或被截断，不要假装读过它们。";

/** Human label for content the model cannot read at all. */
function mediaLabel(ext: string): string {
  if (IMAGE_EXT.includes(ext)) return "图片";
  if (VIDEO_EXT.includes(ext)) return "视频";
  if (ext === "pdf") return "PDF";
  if (["mp3", "wav", "m4a", "ogg", "flac", "aac"].includes(ext)) return "音频";
  return "文件";
}

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
  private nodeMeta = new Map<string, { date?: string; time?: string; tags: string[] }>();
  /** Cached note bodies, keyed by path and validated by mtime. */
  private noteTextCache = new Map<string, { mtime: number; text: string }>();
  private aiPanel: HTMLElement | null = null;
  /** Floating outline. It lives in `root`, not `world`, so panning and
   *  zooming never move it. */
  private outlinePanel: HTMLElement | null = null;
  private outlineBodyEl: HTMLElement | null = null;
  private outlineMetaEl: HTMLElement | null = null;
  private outlineCollapsed = new Set<string>();
  private outlineTimer: number | null = null;
  private outlineSignatureCache = "";
  private outlinePos = { left: 16, top: 58 };
  private aiOutside: ((evt: MouseEvent) => void) | null = null;
  private aiProvider: AIProvider | null = null;
  private aiTargets: BoardNode[] = [];
  private aiHistory: AIMessage[] = [];
  /** Stable prefix: role + board snapshot. Rebuilt only when the board changes. */
  private aiSystem: AISystemBlock[] = [];
  private aiSystemKey = "";
  /** What the last request actually contained, shown in the panel. */
  private aiManifest: SendManifest | null = null;
  /** One snapshot per answer, aligned with `aiAnswers`. */
  private aiSnapshots: Array<AISendSnapshot | null> = [];
  /** N1 → node id, built from the exact snapshot the model was given. */
  private aiNumberMap = new Map<string, string>();
  /** Number badges currently attached to nodes, for fast teardown. */
  private aiBadges = new Map<string, HTMLElement>();
  /** Guards the lazy note-loading pass so it cannot loop. */
  private aiNotesLoading = false;
  private aiAnswers: string[] = [];
  private aiPicked = new Set<number>();
  private aiExpanded = false;
  private aiBusy = false;
  private aiCancelled = false;
  private aiPending: { row: HTMLElement; stop: () => void; say: (text: string) => void } | null =
    null;
  private aiConversationId: string | null = null;
  private aiRestore: ((conv: StoredConversation) => void) | null = null;
  private historyPop: HTMLElement | null = null;
  private historyOutside: ((evt: MouseEvent) => void) | null = null;
  private searchPanel: HTMLElement | null = null;
  private searchOutside: ((evt: MouseEvent) => void) | null = null;
  private clipboard: BoardNode[] = [];
  private clipboardEdges: BoardEdge[] = [];
  private lastPointerWorld: { x: number; y: number } | null = null;
  private insertPanel: HTMLElement | null = null;
  private edgeBar: HTMLElement | null = null;
  private edgeLabelBtn: HTMLButtonElement | null = null;
  private edgeRelationBtn: HTMLButtonElement | null = null;
  /** Report panel for the read-only board health check. */
  private doctorModal: BoardDoctorModal | null = null;
  /** Read-only in-board shortcut reference. */
  private helpModal: ShortcutHelpModal | null = null;
  /** Kept across rescans so a panel parked beside the board stays put. */
  private doctorOffset = { x: 0, y: 0 };
  /** Inline editor for a connection's relation and label; lives in world space
   *  so panning and zooming keep it glued to the line. `t` is where on the line
   *  it sits, and becomes the label's stored position on commit. */
  private edgeLabelEditor: {
    el: HTMLElement;
    input: HTMLInputElement;
    select: HTMLSelectElement;
    edgeId: string;
    t: number;
  } | null = null;
  /** Shared 2D context used to measure label text. Measuring with a canvas
   *  keeps the chip sized correctly even while the board is hidden, where
   *  layout-based APIs (getBBox, getComputedTextLength) report zero. */
  private labelMetrics: CanvasRenderingContext2D | null = null;
  private labelFontCache = "";
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

    // Colours are applied inline, so a theme switch has to repaint them.
    this.registerEvent(this.app.workspace.on("css-change", () => this.repaintColors()));

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
    this.scheduleOutlineRefresh();
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
    if (this.outlineTimer !== null) {
      window.clearTimeout(this.outlineTimer);
      this.outlineTimer = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    // Detach without committing: the DOM is going away underneath it.
    this.closeEdgeLabelEditor(false);
    this.doctorModal?.close();
    this.doctorModal = null;
    this.helpModal?.close();
    this.helpModal = null;
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

    // Create group: these two make a node directly, no picker.
    addButton("sticky-note", "新建便签", () => { void this.createStickyAtCenter(); });
    addButton("type", "新建文本", () => { void this.createTextAtCenter(); });
    toolbar.createDiv({ cls: "volis-board-sep" });

    // Insert group: each opens the picker filtered to one kind.
    addButton("file-text", "添加 md 笔记", () => this.openInsertPanelAtCenter("note"));
    addButton("list", "添加卡片笔记", () => this.openInsertPanelAtCenter("card"));
    addButton("image", "添加媒体文件", () => this.openInsertPanelAtCenter("media"));
    toolbar.createDiv({ cls: "volis-board-sep" });

    addButton("plus", "放大", () => this.zoomBy(1.2));
    addButton("maximize", "总览", () => {
      this.fitToContent();
      this.scheduleSave();
    });
    addButton("minus", "缩小", () => this.zoomBy(1 / 1.2));
    toolbar.createDiv({ cls: "volis-board-sep" });
    this.undoBtn = addButton("undo-2", "撤销", () => void this.undo());
    this.redoBtn = addButton("redo-2", "重做", () => void this.redo());
    addButton("list-tree", "大纲", () => this.toggleOutlinePanel());
    addButton("download", "导出 Markdown", () => this.openExportModal());
    toolbar.createDiv({ cls: "volis-board-sep" });
    addButton("help-circle", "帮助", () => this.openBoardHelp());
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
    this.root.addEventListener("drop", (evt) => { void this.onDrop(evt); });

    this.world.addEventListener("pointerdown", (evt) => {
      const target = evt.target as Element | null;
      if (!(target instanceof SVGElement)) return;
      const group = target.closest<SVGGElement>(".volis-edge-group");
      const edgeId = group?.dataset.edgeId ?? null;
      if (!edgeId) return;
      evt.stopPropagation();
      // A press on a line is not a press on a node: without this the
      // double-click handler would still see whichever node was clicked last.
      this.lastDownNodeId = null;
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

    this.world.addClass("is-loading");
    // The hint sits outside the world layer, so it has to be hidden for the
    // same span, otherwise it flashes over the incoming board.
    this.hintEl.addClass("is-hidden");

    // The editor lives inside the world layer, which is about to be wiped.
    this.closeEdgeLabelEditor(false);

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
      this.world.removeClass("is-loading");
    }

    this.updateHint();
    this.resetHistory();
    this.outlineSignatureCache = "";
    if (this.outlinePanel) this.renderOutlinePanel();
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
    el.style.removeProperty("color");

    if (!color) return;

    const dark = document.body.classList.contains("theme-dark");
    const isGroup = el.classList.contains("is-group");

    // Foreground is pinned together with the fill: relying on the theme's text
    // colour alone breaks the moment one side changes without the other.
    const ink = dark ? "#eceff1" : "#1f2225";

    const applyFill = (line: string, lightFill: string, groupFill: string) => {
      el.style.borderColor = line;
      el.style.background = dark ? this.tintOf(line, isGroup ? 0.45 : 0.66) : lightFill;
      el.style.color = ink;
      if (isGroup) el.style.setProperty("--group-tint", line);
      else el.style.removeProperty("--group-tint");
    };

    if (color.startsWith("#")) {
      applyFill(color, this.tintOf(color), `${color}14`);
      return;
    }

    const preset = NODE_COLORS.find((item) => item.name === color);
    if (!preset) return;

    applyFill(preset.line, preset.bg, `${preset.line}14`);
  }

  /** Blends a colour towards white (light theme) or the board surface (dark). */
  private tintOf(hex: string, amount = 0.84): string {
    const raw = hex.replace("#", "");
    if (raw.length !== 6) return hex;

    const num = parseInt(raw, 16);
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;

    const dark = document.body.classList.contains("theme-dark");
    const base = dark ? 38 : 255;
    const blend = (channel: number) => Math.round(channel + (base - channel) * amount);

    return `#${[blend(r), blend(g), blend(b)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("")}`;
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
    picker.addEventListener("input", () => this.applyNodeColor(nodes, picker.value));
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
    const popWidth = 260;
    pop.style.left = `${Math.round(
      Math.max(8, Math.min(evt.clientX - rect.left - 20, rect.width - popWidth - 8))
    )}px`;
    pop.style.top = `${Math.round(Math.max(8, evt.clientY - rect.top + 12))}px`;

    this.colorOutside = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && pop.contains(target)) return;
      this.closeColorPop();
    };
    document.addEventListener("mousedown", this.colorOutside, true);
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
    pop.style.left = `${Math.round(
      Math.max(8, Math.min(evt.clientX - rect.left - 40, rect.width - width - 8))
    )}px`;
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
        id: "ai",
        icon: "sparkles",
        label: "AI 分析",
        run: () => this.openAIPanel(),
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

  private repaintColors(): void {
    for (const node of this.nodes) {
      const el = this.nodeEls.get(node.id);
      if (el) this.paintColor(el, node.color);
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
      };
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
    // The editor points at an edge object that is about to be replaced.
    this.closeEdgeLabelEditor(false);
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

    this.pruneEdges();
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

  /**
   * Curve that leaves along the side's normal, like the native canvas does.
   * Returns the control points as well as the path: the label, its editor and
   * the style bar all need a point along the same curve, so they resolve it
   * from here instead of each keeping their own idea of "the middle".
   */
  private orientedPath(
    p1: { x: number; y: number },
    side1: PortSide,
    p2: { x: number; y: number },
    side2: PortSide
  ): EdgeCurve {
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const offset = Math.max(28, Math.min(150, dist * 0.35));

    const n1 = this.sideNormal(side1);
    const n2 = this.sideNormal(side2);

    const c1 = { x: p1.x + n1.x * offset, y: p1.y + n1.y * offset };
    const c2 = { x: p2.x + n2.x * offset, y: p2.y + n2.y * offset };

    const curve: Curve = { p1, c1, c2, p2 };
    return { ...curve, d: curvePath(curve) };
  }

  /** One edge's geometry, shared by the renderer and the label editor. */
  private edgeGeometry(edge: BoardEdge): EdgeCurve | null {
    const from = this.nodeMap.get(edge.from);
    const to = this.nodeMap.get(edge.to);
    if (!from || !to) return null;

    const fromSide = edge.fromSide ?? this.nearestSide(from, to.x + to.width / 2, to.y);
    const toSide = edge.toSide ?? this.nearestSide(to, from.x + from.width / 2, from.y);

    const start = this.portPoint(from, fromSide);
    const end = this.portPoint(to, toSide);

    return this.orientedPath(start, fromSide, end, toSide);
  }

  /** Stored label, trimmed and capped. Hand-edited files must not throw. */
  private edgeLabelOf(edge: BoardEdge): string {
    const raw = typeof edge.label === "string" ? edge.label.trim() : "";
    return raw.slice(0, EDGE_LABEL_MAX);
  }

  /** What the chip shows: the user's label if present, otherwise the relation
   *  name, so a semantic edge stays readable without opening the editor. */
  private edgeDisplayLabel(edge: BoardEdge): string {
    const label = this.edgeLabelOf(edge);
    if (label) return label;
    return edge.relation ? EDGE_RELATION_BY_ID.get(edge.relation)?.label ?? "" : "";
  }

  /** Where the label sits on the line. Missing or out-of-range values in a
   *  hand-edited file fall back to the middle rather than throwing. */
  private edgeLabelT(edge: BoardEdge): number {
    return typeof edge.labelAt === "number" ? clampLabelT(edge.labelAt) : 0.5;
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

      const geometry = this.edgeGeometry(edge);
      if (!geometry) continue;

      const d = geometry.d;

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
      const relation = edge.relation ? EDGE_RELATION_BY_ID.get(edge.relation) : undefined;
      const style = edge.style ?? relation?.style;
      path.setAttribute("marker-end", "url(#volis-arrow)");
      if (style === "dashed") path.setAttribute("stroke-dasharray", "6 4");

      const stroke = this.lineColorOf(edge.color) ?? this.lineColorOf(relation?.color);
      if (stroke) path.style.stroke = stroke;

      const arrow = edge.arrow ?? relation?.arrow ?? "target";
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
      this.attachEdgeLabel(group, edge, geometry);
      svg.appendChild(group);
    }

  }

  /**
   * Label chip drawn above the stroke at the label's own point on the line: a
   * rounded plate in the card colour plus a hairline border, so the stroke
   * reads as interrupted behind the text instead of cutting through it. Both
   * shapes live in the edge group, so they scale, pan and get selected along
   * with the line and need no repositioning of their own.
   */
  private attachEdgeLabel(group: SVGGElement, edge: BoardEdge, curve: EdgeCurve): void {
    const stored = this.edgeLabelOf(edge);
    const label = stored || this.edgeDisplayLabel(edge);
    if (!label) return;

    const anchor = curvePoint(curve, this.edgeLabelT(edge));

    const text = this.svgNode("text");
    text.setAttribute("class", stored ? "volis-edge-label" : "volis-edge-label is-relation");
    text.setAttribute("x", String(anchor.x));
    text.setAttribute("y", String(anchor.y));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "central");
    // One font spec drives both the glyphs and the measurement below, so the
    // chip can never be sized for a font the text is not rendered in.
    text.style.font = this.labelFont();
    text.textContent = label;

    const width = this.edgeLabelWidth(label) + EDGE_LABEL_PAD_X * 2;

    const chip = this.svgNode("rect");
    chip.setAttribute("class", "volis-edge-label-bg");
    chip.setAttribute("x", String(anchor.x - width / 2));
    chip.setAttribute("y", String(anchor.y - EDGE_LABEL_HEIGHT / 2));
    chip.setAttribute("width", String(width));
    chip.setAttribute("height", String(EDGE_LABEL_HEIGHT));
    chip.setAttribute("rx", String(EDGE_LABEL_RADIUS));

    group.appendChild(chip);
    group.appendChild(text);
  }

  /**
   * Font spec for a label. The interface font comes from the theme, the rest
   * from the constants above, and the result is applied inline — reading it
   * back off the `<text>` element is not an option, because these labels are
   * measured while the group is still detached (and the board is hidden), where
   * `getComputedStyle` returns empty values and any measurement built on it
   * silently falls back to the canvas default.
   */
  private labelFont(): string {
    if (this.labelFontCache) return this.labelFontCache;

    const family =
      window.getComputedStyle(this.root).getPropertyValue("--font-interface").trim() ||
      "sans-serif";

    this.labelFontCache = `500 ${EDGE_LABEL_FONT_SIZE}px ${family}`;
    return this.labelFontCache;
  }

  /**
   * Rendered width of the label, in board units, from canvas metrics.
   * `getBBox()`/`getComputedTextLength()` would be exact but report zero
   * whenever the board is not laid out, so a chip sized from them would
   * collapse to a dot on load and in a background tab.
   */
  private edgeLabelWidth(value: string): number {
    if (!this.labelMetrics) {
      this.labelMetrics = document.createElement("canvas").getContext("2d");
      if (this.labelMetrics) this.labelMetrics.font = this.labelFont();
    }
    if (!this.labelMetrics) return value.length * EDGE_LABEL_FONT_SIZE;

    return this.labelMetrics.measureText(value).width;
  }

  /** Small icon sitting on the top border, so the node type stays readable
   *  even when the content is scaled down to an illegible blur. */
  private attachTypeBadge(el: HTMLElement, node: BoardNode): void {
    const ext = node.type === "file" ? (node.file.split(".").pop() ?? "").toLowerCase() : "";

    let kind = "file";
    let icon = "file";

    if (node.type === "card") {
      kind = "card";
      icon = "quote";
    } else if (node.type === "text") {
      kind = node.sticky ? "sticky" : "text";
      icon = node.sticky ? "sticky-note" : "type";
    } else if (ext === "md") {
      kind = "note";
      icon = "file-text";
    } else if (IMAGE_EXT.includes(ext)) {
      kind = "image";
      icon = "image";
    } else if (VIDEO_EXT.includes(ext)) {
      kind = "video";
      icon = "video";
    }

    const badge = el.createDiv({ cls: "volis-type-badge" });
    badge.dataset.kind = kind;
    setIcon(badge, icon);
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
      // Enter while an IME is composing confirms the candidate, not the field.
      if (evt.isComposing) return;

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

  /**
   * A group only stores a rectangle, so a selected group must be paired with
   * the nodes it holds. Without this the AI would be handed a bare frame and
   * answer "this group is empty" while four cards sit inside it.
   */
  private expandGroups(nodes: BoardNode[]): BoardNode[] {
    const out: BoardNode[] = [];
    const seen = new Set<string>();

    const push = (node: BoardNode): void => {
      if (seen.has(node.id)) return;
      seen.add(node.id);
      out.push(node);
    };

    for (const node of nodes) {
      push(node);
      if (node.type !== "group") continue;
      for (const member of this.groupMembers(node)) push(member);
    }

    return out;
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

    el.toggleClass("is-sticky", node.type === "text" && Boolean(node.sticky));
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

      this.attachTypeBadge(el, node);
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

    // A file edit can rebuild a node mid-conversation; restore its number.
    if (this.aiPanel && this.aiNumberMap.size >= 2 && this.aiNumberMap.has(node.id)) {
      const badge = el.createDiv({
        cls: "volis-ai-node-number",
        text: this.aiNumberMap.get(node.id),
      });
      badge.setAttribute("aria-hidden", "true");
      this.aiBadges.set(node.id, badge);
    }

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
    this.nodeMeta.set(node.id, { date: meta.date, time: meta.time, tags: meta.tags });
    await MarkdownRenderer.render(this.app, normalizeTags(meta.body), body, node.file, this);
    this.decorateNumericTags(body);

    const parts: string[] = [];
    if (meta.date) parts.push(meta.date.slice(5));

    if (parts.length > 0) {
      el.createDiv({ cls: "volis-bnode-meta", text: parts.join("  ") });
    }
  }

  /**
   * Reads a note for the AI context. Capped so a 300-page note cannot blow up
   * memory; the budget builder trims it further. Frontmatter is dropped since
   * it is metadata, not content.
   */
  private async readNoteText(file: TFile): Promise<string> {
    const cached = this.noteTextCache.get(file.path);
    if (cached && cached.mtime === file.stat.mtime) return cached.text;

    let body = "";
    try {
      body = await this.app.vault.cachedRead(file);
    } catch (error) {
      return file.basename;
    }

    const stripped = body.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
    const text = stripped.length > 100000 ? `${stripped.slice(0, 100000)}\n…（超长，已截断）` : stripped;
    this.noteTextCache.set(file.path, { mtime: file.stat.mtime, text });
    return text;
  }

  private async renderFileBody(el: HTMLElement, node: { id: string; file: string }): Promise<void> {
    el.addClass("is-file");
    const file = this.app.vault.getAbstractFileByPath(node.file);
    if (file instanceof TFile) {
      // A note's body is what the AI needs. Without this the model only ever
      // saw "文件名.md" and silently answered from nothing.
      const isNote = file.extension.toLowerCase() === "md";
      this.nodeText.set(node.id, isNote ? await this.readNoteText(file) : file.basename);
    }

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
    this.syncEdgeLabelEditor();
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
    // Counting is a plain scan: opening the menu must never modify the board.
    const issueCount = scanBoard(this.doctorInput()).length;

    menu.addItem((item) =>
      item
        .setTitle("查找节点")
        .setIcon("search")
        .onClick(() => this.openNodeSearch())
    );

    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle(issueCount > 0 ? `白板体检（${issueCount}）` : "白板体检")
        .setIcon("stethoscope")
        .onClick(() => this.openBoardDoctor())
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

  /** Snapshot for the read-only scan. Reuses the view's own maps and caches. */
  private doctorInput(): DoctorInput {
    return {
      nodes: this.nodes,
      edges: this.edges,
      staleIds: this.staleIds,
      textOf: (node) =>
        this.nodeText.get(node.id) ?? (node.type === "text" ? node.text : ""),
      heightOf: (node) => this.nodeHeight(node),
      memberIdsOf: (group) => this.groupMembers(group).map((member) => member.id),
    };
  }

  /** Opens the health report. Scanning is read-only; nothing is applied here. */
  public openBoardDoctor(): void {
    const issues = scanBoard(this.doctorInput());
    const actions: DoctorActions = {
      locate: (issue) => this.locateDoctorIssue(issue),
      removeNode: (id) => this.confirmDoctorRemoveNode(id),
      removeEdge: (id) => this.confirmDoctorRemoveEdge(id),
      addLabel: (id) => {
        // Same as "定位": bring the line to the centre first. Otherwise the
        // field opens somewhere the user cannot see while the report is up.
        if (!this.centerOnEdge(id)) return;
        // The report sits above the canvas; close it so the inline field can
        // actually receive focus, then open the field on the next tick.
        this.doctorModal?.close();
        this.doctorModal = null;
        window.setTimeout(() => this.openEdgeLabelEditor(id), 0);
      },
      rescan: () => this.openBoardDoctor(),
      offset: () => ({ ...this.doctorOffset }),
      moved: (offset) => {
        this.doctorOffset = { ...offset };
      },
    };

    this.doctorModal?.close();
    this.doctorModal = new BoardDoctorModal(this.app, issues, actions);
    this.doctorModal.open();
  }

  /** Read-only reference for the gestures available inside this board. */
  private openBoardHelp(): void {
    this.helpModal?.close();
    this.helpModal = new ShortcutHelpModal(this.app);
    this.helpModal.open();
  }

  /** Jump to the subject of a finding without changing any board data. */
  private locateDoctorIssue(issue: DoctorIssue): void {
    const firstId = issue.nodeIds[0];
    if (firstId) {
      const node = this.nodeMap.get(firstId);
      if (node) {
        // Locate means locate: centre and select only this one node. Adding
        // the other node to the selection would draw the multi-select frame
        // around unrelated cards and change the toolbar state.
        this.centerOnNode(node);
        return;
      }
    }

    if (!issue.edgeId) return;
    this.centerOnEdge(issue.edgeId);
  }

  /**
   * Centre and select a connection. Shared by the report's "定位" and by
   * "添加标签", so the inline editor always opens where the user can see it.
   */
  private centerOnEdge(edgeId: string): boolean {
    const edge = this.edges.find((item) => item.id === edgeId);
    if (!edge) return false;

    this.selectedEdgeId = edge.id;
    this.selection.clear();
    this.paintSelection();
    this.paintEdgeSelection();
    this.updateEdgeBar();

    const curve = this.edgeGeometry(edge);
    if (curve) {
      const anchor = curvePoint(curve, this.edgeLabelT(edge));
      const rect = this.root.getBoundingClientRect();
      this.tx = rect.width / 2 - anchor.x * this.scale;
      this.ty = rect.height / 2 - anchor.y * this.scale;
      this.applyTransform();
      this.scheduleSave();
    }
    return true;
  }

  private confirmDoctorRemoveNode(nodeId: string): void {
    const node = this.nodeMap.get(nodeId);
    if (!node) return;
    if (this.nodeEls.get(nodeId)?.hasClass("volis-editing")) {
      new Notice("请先结束这张卡片的编辑再移除");
      return;
    }

    new ConfirmModal(
      this.app,
      "移除这个节点？",
      `将从白板移除「${doctorNodeName(node)}」，相关连线一并清除。源笔记不会被修改，可按 Ctrl+Z 撤销。`,
      "移除节点",
      () => {
        this.selection.clear();
        this.selection.add(nodeId);
        this.deleteSelection();
        new Notice("已移除节点，可按 Ctrl+Z 撤销");
        this.openBoardDoctor();
      }
    ).open();
  }

  private confirmDoctorRemoveEdge(edgeId: string): void {
    const edge = this.edges.find((item) => item.id === edgeId);
    if (!edge) return;

    new ConfirmModal(
      this.app,
      "删除这条连线？",
      "只删除这条连线，节点不受影响，可按 Ctrl+Z 撤销。",
      "删除连线",
      () => {
        this.selectedEdgeId = edgeId;
        this.deleteSelectedEdge();
        new Notice("已删除连线，可按 Ctrl+Z 撤销");
        this.openBoardDoctor();
      }
    ).open();
  }

  /**
   * Drops connections whose endpoints no longer exist. Both delete paths call
   * this, so a removed node never leaves a dangling line behind.
   */
  private pruneEdges(): void {
    const before = this.edges.length;

    this.edges = this.edges.filter(
      (edge) => this.nodeMap.has(edge.from) && this.nodeMap.has(edge.to)
    );

    if (this.edges.length === before) return;

    if (this.selectedEdgeId && !this.edges.some((edge) => edge.id === this.selectedEdgeId)) {
      this.selectedEdgeId = null;
      this.updateEdgeBar();
    }

    const editor = this.edgeLabelEditor;
    if (editor && !this.edges.some((edge) => edge.id === editor.edgeId)) {
      this.closeEdgeLabelEditor(false);
    }
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

  /**
   * Hit test for the native scrollbar. Everything here is in screen pixels:
   * getBoundingClientRect() already includes the board's zoom transform, so it
   * must NOT be compared with clientWidth/offsetWidth (unscaled CSS pixels).
   */
  private isOnScrollbar(body: HTMLElement, clientX: number): boolean {
    const cssWidth = body.offsetWidth;
    const barCss = cssWidth - body.clientWidth;
    if (barCss <= 0) return false;

    const rect = body.getBoundingClientRect();
    if (rect.width <= 0 || cssWidth <= 0) return false;

    const scale = rect.width / cssWidth;
    const barScreen = barCss * scale;

    return clientX - rect.left >= rect.width - barScreen;
  }

  private onWheel = (evt: WheelEvent): void => {
    // While editing, the wheel belongs to the textarea's own scrollbar, not to
    // the board zoom.
    const target = evt.target as HTMLElement | null;
    if (target?.closest(".volis-inline")) return;
    if (target?.closest(".volis-insert-panel")) return;
    if (target?.closest(".volis-ai-panel")) return;
    if (target?.closest(".volis-outline-panel")) return;
    // Only a SELECTED node claims the wheel for its own content. Hovering an
    // unselected node must still zoom the board.
    const hoveredBody = target?.closest<HTMLElement>(".volis-bnode-body");
    if (hoveredBody) {
      const nodeEl = hoveredBody.closest<HTMLElement>(".volis-bnode");
      const nodeId = nodeEl?.dataset?.nodeId;
      if (nodeId && this.selection.has(nodeId)) return;
    }

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
    if (target.closest(".volis-outline-panel")) return;

    const nodeEl = target.closest<HTMLElement>(".volis-bnode");
    const nodeId = nodeEl?.dataset?.nodeId ?? null;
    this.lastDownNodeId = nodeId;

    const portEl = target.closest<HTMLElement>(".volis-port");
    if (portEl && nodeId) {
      this.startLinkDrag(evt, nodeId, portEl.dataset.port ?? "right");
      return;
    }

    const handleEl = target.closest<HTMLElement>(".volis-resize-handle");
    if (handleEl && nodeId) {
      this.startResize(evt, nodeId, (handleEl.dataset.dir as ResizeDir) ?? "se");
      return;
    }

    if (target.closest(".volis-bnode.is-playing")) return;

    // A press on the native scrollbar belongs to the browser. If we start a
    // node drag here, pointer capture steals the events and the thumb cannot
    // be dragged at all.
    const bodyEl = target.closest<HTMLElement>(".volis-bnode-body");
    if (bodyEl && this.isOnScrollbar(bodyEl, evt.clientX)) return;

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

  private closeAiPanel(): void {
    this.closeHistoryPop();
    if (this.aiOutside) {
      document.removeEventListener("mousedown", this.aiOutside, true);
      this.aiOutside = null;
    }
    this.clearNodeNumbers();
    this.aiPanel?.remove();
    this.aiPanel = null;
  }

  /**
   * Maps board nodes to the plain data the budget builder understands. Node
   * types live here, token math lives in ai/context.ts — adding a node type
   * only touches this function.
   */
  private contextInput(nodes: BoardNode[]): {
    nodes: ContextNodeInput[];
    groups: ContextGroupInput[];
    edges: ContextEdgeInput[];
  } {
    const present = new Set(nodes.map((node) => node.id));
    const inputs: ContextNodeInput[] = [];
    const groups: ContextGroupInput[] = [];

    for (const node of nodes) {
      if (node.type === "group") {
        const members = this.groupMembers(node).filter((member) => present.has(member.id));
        groups.push({
          id: node.id,
          label: node.label ?? "未命名",
          memberIds: members.map((member) => member.id),
        });
        continue;
      }

      const meta = this.nodeMeta.get(node.id);
      const text = this.nodeText.get(node.id) ?? "";

      if (node.type === "file") {
        const ext = node.file.split(".").pop()?.toLowerCase() ?? "";
        const isNote = ext === "md" || ext === "markdown";
        const name = node.file.split("/").pop() ?? node.file;
        inputs.push({
          id: node.id,
          kind: isNote ? "note" : "file",
          label: name.replace(/\.md$/i, ""),
          text: isNote ? text : "",
          readable: isNote,
          mediaKind: isNote ? undefined : mediaLabel(ext),
          path: node.file,
        });
        continue;
      }

      const kind = node.type === "card" ? "card" : "text";
      const firstLine = text.split("\n").find((line) => line.trim()) ?? "";
      inputs.push({
        id: node.id,
        kind,
        label: firstLine.trim().slice(0, 24) || (kind === "card" ? "卡片" : "文本"),
        text,
        readable: true,
        meta: meta ? { date: meta.date, time: meta.time, tags: meta.tags } : undefined,
        color: "color" in node ? node.color : undefined,
      });
    }

    const edges = this.edges
      .filter((edge) => present.has(edge.from) && present.has(edge.to))
      .map((edge) => ({
        from: edge.from,
        to: edge.to,
        label: edge.label,
        relation: edge.relation
          ? EDGE_RELATION_BY_ID.get(edge.relation)?.label
          : undefined,
      }));

    return { nodes: inputs, groups, edges };
  }

  /** Tokens available for board content: window minus answer minus safety. */
  private inputBudget(profile: AIProfile | null): number {
    const policy = this.plugin.settings.ai.policy;
    const window = profile?.capability?.contextWindow ?? 128000;
    const output = profile?.capability?.maxOutput ?? 8192;
    return Math.max(2000, window - output - policy.safetyTokens);
  }

  /**
   * Rebuilds the cached board prefix. Only re-runs when the selection or the
   * node text actually changed, so the cache marker keeps hitting between
   * turns. `force` is used after an edit or when the model profile changes.
   */
  private ensureSystem(profile: AIProfile | null, force = false): void {
    const nodeKey = this.aiTargets
      .map((node) => {
        const text = this.nodeText.get(node.id) ?? "";
        return `${node.id}:${node.type}:${text.length}:${"label" in node ? node.label : ""}`;
      })
      .join("|");

    // Relations are part of the prefix too: a renamed or newly added
    // connection label must not be answered against a stale snapshot.
    const targetIds = new Set(this.aiTargets.map((node) => node.id));
    const edgeKey = this.edges
      .filter((edge) => targetIds.has(edge.from) && targetIds.has(edge.to))
      .map((edge) => `${edge.from}>${edge.to}:${edge.label ?? ""}`)
      .join("|");

    const key = `${nodeKey}#${edgeKey}`;

    if (!force && key === this.aiSystemKey && this.aiSystem.length > 0) return;

    const policy = this.plugin.settings.ai.policy;
    const result = buildBoardContext(
      this.contextInput(this.aiTargets),
      this.inputBudget(profile),
      policy
    );

    this.aiManifest = result.manifest;
    this.aiNumberMap = new Map(
      result.manifest.nodes.map((node) => [node.tag, node.id] as const)
    );
    this.aiSystemKey = key;
    this.aiSystem = [
      { text: AI_ROLE_PROMPT },
      { text: `【白板内容】\n${result.text}`, cache: true },
    ];

    // A note may not have been rendered yet when the panel opened. Load it once
    // and rebuild, so the user never sees "笔记内容为空" for a real note.
    const missing = this.aiTargets.filter(
      (node) =>
        node.type === "file" &&
        node.file.toLowerCase().endsWith(".md") &&
        !(this.nodeText.get(node.id) ?? "").trim()
    );

    if (missing.length > 0 && !this.aiNotesLoading) {
      this.aiNotesLoading = true;
      void Promise.all(
        missing.map(async (node) => {
          if (node.type !== "file") return;
          const file = this.app.vault.getAbstractFileByPath(node.file);
          if (!(file instanceof TFile)) return;
          this.nodeText.set(node.id, await this.readNoteText(file));
        })
      ).then(() => {
        this.aiNotesLoading = false;
        this.ensureSystem(profile, true);
        this.applyNodeNumbers();
      });
    }
  }

  /**
   * Number badges are decoration only: they live on the node element, never in
   * the board JSON, and disappear when the AI panel closes.
   */
  private applyNodeNumbers(): void {
    this.clearNodeNumbers();
    // One node needs no numbering: the model will talk about "this card".
    if (this.aiNumberMap.size < 2) return;

    for (const [tag, nodeId] of this.aiNumberMap) {
      const el = this.nodeEls.get(nodeId);
      if (!el || el.querySelector(":scope > .volis-ai-node-number")) continue;

      const badge = el.createDiv({ cls: "volis-ai-node-number", text: tag });
      badge.setAttribute("aria-hidden", "true");
      this.aiBadges.set(nodeId, badge);
    }
  }

  private clearNodeNumbers(): void {
    for (const badge of this.aiBadges.values()) badge.remove();
    this.aiBadges.clear();
  }

  private historyTokens(): number {
    return this.aiHistory.reduce((sum, message) => sum + estimateTokens(message.content), 0);
  }

  /** Profile setting wins; otherwise the global default; otherwise vendor. */
  private resolveThinking(profile: AIProfile | null): AIThinkingMode {
    const mode = profile?.thinking ?? this.plugin.settings.ai.thinking;
    return mode === "on" || mode === "off" ? mode : "auto";
  }

  /**
   * Collapses early turns into one summary, keeping the last two exchanges raw.
   * Only history is compressed — the board prefix lives in `aiSystem` and is
   * never summarised, so the material stays intact however long the chat runs.
   */
  private async compactHistory(profile: AIProfile | null): Promise<void> {
    const budget = this.inputBudget(profile);
    // History should not crowd out the material it is asking about.
    const threshold = Math.max(2000, Math.floor(budget * 0.35));

    if (this.aiHistory.length <= 4 || this.historyTokens() <= threshold) return;

    const recent = this.aiHistory.slice(-4);
    const older = this.aiHistory.slice(0, -4);

    const transcript = older
      .map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.content}`)
      .join("\n\n");

    let summary = "";
    try {
      const result = await this.aiProvider?.complete(
        [
          {
            role: "user",
            content: `请把下面这段对话压缩成要点，保留结论、判断、用户意图和未解决的问题，去掉过程描述与重复内容：\n\n${transcript}`,
          },
        ],
        {
          system: "你是对话摘要助手。只输出摘要正文，不要寒暄，不要标题。",
          maxTokens: 800,
          thinking: "off",
          cache: false,
        }
      );
      summary = result?.text ?? "";
    } catch (error) {
      // A failed summary must never block the question itself.
      return;
    }

    if (!summary.trim()) return;

    const block = `【此前对话摘要】\n${summary.trim()}`;
    const head = recent[0];

    this.aiHistory =
      head.role === "user"
        ? [{ role: "user", content: `${block}\n\n${head.content}` }, ...recent.slice(1)]
        : [{ role: "user", content: block }, ...recent];

    new Notice("对话较长，早期的往来已压缩为摘要（白板内容不受影响）");
  }

  public openAIPanel(): void {
    this.closeAiPanel();

    const profile = activeProfile(this.plugin.settings.ai);
    const provider = createProvider(profile);

    if (!this.plugin.settings.ai.enabled || !provider.configured) {
      new Notice("请先在设置中启用 AI 并添加一个模型配置");
      return;
    }

    const selected = this.selectedNodes();
    // A group is only a rectangle: expand it to the nodes it holds, otherwise
    // the model sees an "empty" frame while the cards sit right there.
    const expanded = selected.length > 0 ? this.expandGroups(selected) : [];
    const contentNodes = expanded.filter((node) => node.type !== "group");

    if (selected.length > 0 && contentNodes.length === 0) {
      new Notice("选中的分组里还没有内容，先把卡片放进去再分析");
      return;
    }

    // The context builder trims to budget, so the raw cap can be generous.
    const targets = expanded.length > 0 ? expanded : this.nodes.slice(0, 200);
    if (targets.length === 0) {
      new Notice("白板上还没有节点");
      return;
    }
    // Groups are frames, not content: count only the nodes holding text.
    const targetCount =
      targets.filter((node) => node.type !== "group").length || targets.length;

    this.aiProvider = provider;
    this.aiTargets = targets;
    this.aiHistory = [];
    this.aiSystem = [];
    this.aiSystemKey = "";
    this.aiManifest = null;
    this.aiAnswers = [];
    this.aiSnapshots = [];
    this.aiPicked = new Set<number>();
    this.aiBusy = false;
    this.aiConversationId = null;
    this.aiExpanded = false;

    // Build the board snapshot once per opening; each answer carries its copy.
    this.ensureSystem(profile, true);
    this.applyNodeNumbers();

    const rect = this.root.getBoundingClientRect();
    const box = this.selectionBox(targets);

    const panel = this.root.createDiv({ cls: "volis-ai-panel" });
    this.aiPanel = panel;
    panel.addEventListener("pointerdown", (evt) => evt.stopPropagation());
    panel.addEventListener("dblclick", (evt) => evt.stopPropagation());

    const head = panel.createDiv({ cls: "volis-ai-head" });
    const headIcon = head.createDiv({ cls: "volis-ai-head-icon" });
    setIcon(headIcon, "sparkles");
    head.createDiv({
      cls: "volis-ai-head-title",
      text: `${selected.length > 0 ? "分析选中的" : "分析全部"} ${targetCount} 个节点`,
    });
    head.createDiv({ cls: "volis-ai-head-model", text: profile?.name ?? "" });
    head.createDiv({ cls: "volis-ai-head-spacer" });

    const newBtn = head.createEl("button", {
      cls: "volis-ai-head-btn",
      attr: { "aria-label": "新对话" },
    });
    setIcon(newBtn, "square-pen");

    const historyBtn = head.createEl("button", {
      cls: "volis-ai-head-btn",
      attr: { "aria-label": "历史对话" },
    });
    setIcon(historyBtn, "history");

    const expandBtn = head.createEl("button", {
      cls: "volis-ai-head-btn",
      attr: { "aria-label": "展开" },
    });
    setIcon(expandBtn, "maximize-2");

    const closeBtn = head.createEl("button", {
      cls: "volis-ai-head-btn",
      attr: { "aria-label": "关闭" },
    });
    setIcon(closeBtn, "x");

    const stream = panel.createDiv({ cls: "volis-ai-stream" });

    // The input dock floats over the stream instead of splitting it with a rule.
    const dock = panel.createDiv({ cls: "volis-ai-dock" });
    const compose = dock.createDiv({ cls: "volis-ai-compose" });
    const input = compose.createEl("input", {
      cls: "volis-ai-input",
      attr: { type: "text", placeholder: "问点什么，或继续追问…" },
    });
    const sendBtn = compose.createEl("button", {
      cls: "volis-ai-send",
      attr: { "aria-label": "发送" },
    });
    setIcon(sendBtn, "arrow-up");

    const actions = dock.createDiv({ cls: "volis-ai-actions" });
    const insertBtn = actions.createEl("button", {
      cls: "volis-ai-btn is-primary",
      text: "插入为新节点",
    });
    const overwriteBtn = actions.createEl("button", { cls: "volis-ai-btn", text: "覆盖原节点" });
    const noteBtn = actions.createEl("button", { cls: "volis-ai-btn", text: "存为笔记" });

    insertBtn.disabled = true;
    noteBtn.disabled = true;

    // Overwriting only makes sense for a single editable node.
    const single = targets.length === 1 ? targets[0] : null;
    const overwriteTarget =
      single &&
      (single.type === "text" ||
        single.type === "card" ||
        (single.type === "file" && single.file.toLowerCase().endsWith(".md")))
        ? single
        : null;

    if (!overwriteTarget) {
      overwriteBtn.addClass("is-hidden");
    } else {
      overwriteBtn.disabled = true;
    }

    const syncActions = () => {
      const has = this.aiPicked.size > 0 && !this.aiBusy;
      insertBtn.disabled = !has;
      noteBtn.disabled = !has;
      if (overwriteTarget) overwriteBtn.disabled = !has;

      const count = this.aiPicked.size;
      insertBtn.setText(count > 1 ? `插入为新节点（${count} 条）` : "插入为新节点");
      noteBtn.setText(count > 1 ? `存为笔记（${count} 条）` : "存为笔记");
      if (overwriteTarget) {
        overwriteBtn.setText(count > 1 ? `覆盖原节点（${count} 条）` : "覆盖原节点");
      }
    };

    syncActions();

    let dragStart: { x: number; y: number; left: number; top: number } | null = null;

    head.addEventListener("pointerdown", (evt) => {
      if ((evt.target as HTMLElement).closest("button")) return;
      if (this.aiExpanded) return;

      dragStart = {
        x: evt.clientX,
        y: evt.clientY,
        left: panel.offsetLeft,
        top: panel.offsetTop,
      };

      head.setPointerCapture(evt.pointerId);
      panel.addClass("is-dragging");
    });

    head.addEventListener("pointermove", (evt) => {
      if (!dragStart) return;
      panel.style.left = `${Math.round(dragStart.left + evt.clientX - dragStart.x)}px`;
      panel.style.top = `${Math.round(dragStart.top + evt.clientY - dragStart.y)}px`;
    });

    const endDrag = (evt: PointerEvent) => {
      if (!dragStart) return;
      dragStart = null;
      panel.removeClass("is-dragging");
      try {
        head.releasePointerCapture(evt.pointerId);
      } catch (error) {
        // pointer already released
      }
    };

    head.addEventListener("pointerup", endDrag);
    head.addEventListener("pointercancel", endDrag);

    const place = () => {
      if (this.aiExpanded) {
        panel.style.left = `${Math.round(rect.width * 0.1)}px`;
        panel.style.top = `${Math.round(rect.height * 0.06)}px`;
        return;
      }

      const panelWidth = 580;
      const screenLeft = box ? box.minX * this.scale + this.tx : rect.width / 2;
      const screenTop = box ? box.minY * this.scale + this.ty : rect.height / 2;
      const boxWidth = box ? (box.maxX - box.minX) * this.scale : 0;

      let left = screenLeft + (boxWidth - panelWidth) / 2;
      left = Math.max(8, Math.min(left, rect.width - panelWidth - 8));

      // The node toolbar floats just above the selection; tuck the panel
      // directly underneath it instead of leaving a gap.
      let top = screenTop - 6;
      top = Math.max(8, Math.min(top, rect.height - 560));

      panel.style.left = `${Math.round(left)}px`;
      panel.style.top = `${Math.round(top)}px`;
    };

    place();

    const scrollDown = () => {
      stream.scrollTop = stream.scrollHeight;
    };

    const addUserBubble = (text: string) => {
      const row = stream.createDiv({ cls: "volis-ai-msg is-user" });
      row.createDiv({ cls: "volis-ai-bubble", text });
      scrollDown();
    };

    const refreshPicks = () => {
      stream.querySelectorAll(".volis-ai-msg.is-ai").forEach((row) => {
        const index = Number((row as HTMLElement).dataset.answerIndex ?? "-1");
        row.toggleClass("is-picked", this.aiPicked.has(index));
      });
      syncActions();
    };

    const togglePick = (index: number) => {
      if (this.aiPicked.has(index)) this.aiPicked.delete(index);
      else this.aiPicked.add(index);
      refreshPicks();
    };

    const clearPickOutside = (evt: MouseEvent) => {
      const target = evt.target as HTMLElement;
      // Clicks on an answer row are handled by that row (toggle).
      if (target.closest(".volis-ai-msg.is-ai")) return;
      // The action bar and input need the current selection to stay intact.
      if (target.closest(".volis-ai-actions, .volis-ai-compose")) return;
      if (this.aiPicked.size === 0) return;
      this.aiPicked.clear();
      refreshPicks();
    };

    this.aiOutside = clearPickOutside;
    document.addEventListener("mousedown", this.aiOutside, true);

    /** The collapsed "read context" block shared by pending and final rows. */
    const appendContext = (
      host: HTMLElement,
      snapshot: AISendSnapshot | null
    ): HTMLElement | null => {
      if (!snapshot) return null;

      const details = host.createEl("details", { cls: "volis-ai-context" });
      const summary = details.createEl("summary");
      const label = summary.createSpan({ cls: "volis-ai-context-label", text: "已读取上下文" });
      summary.createSpan({
        cls: "volis-ai-context-count",
        text: `${snapshot.nodes.length} 个节点 · ${formatTokens(snapshot.usedTokens)} token`,
      });

      const body = details.createDiv({ cls: "volis-ai-context-body" });
      for (const node of snapshot.nodes) {
        const line = body.createDiv({ cls: "volis-ai-context-row" });
        line.createSpan({ cls: "volis-ai-context-tag", text: node.tag });
        line.createSpan({ cls: "volis-ai-context-name", text: node.label });
        line.createSpan({
          cls: "volis-ai-context-size",
          text: node.readable ? `${node.charsSent}/${node.charsTotal} 字` : "仅文件名",
        });
        if (node.note) line.createSpan({ cls: "volis-ai-context-flag", text: node.note });
      }
      for (const note of snapshot.notes) {
        body.createDiv({ cls: "volis-ai-context-note", text: note });
      }
      return label;
    };

    /** Copy button: icon brightens on hover, turns into a check when done. */
    const appendCopy = (host: HTMLElement, text: string): void => {
      const button = host.createEl("button", { cls: "volis-ai-reply-icon" });
      setIcon(button, "copy");
      button.addEventListener("click", (evt) => {
        evt.stopPropagation();
        void navigator.clipboard.writeText(text).then(
          () => {
            setIcon(button, "check");
            button.addClass("is-done");
            window.setTimeout(() => {
              setIcon(button, "copy");
              button.removeClass("is-done");
            }, 1200);
          },
          () => new Notice("复制失败，请检查剪贴板权限")
        );
      });
    };

    const addAiBubble = async (
      text: string,
      snapshot: AISendSnapshot | null = null,
      selectable = true
    ): Promise<HTMLElement> => {
      const index = this.aiAnswers.length;
      this.aiAnswers.push(text);
      this.aiSnapshots.push(snapshot);

      const row = stream.createDiv({ cls: "volis-ai-msg is-ai" });
      row.dataset.answerIndex = String(index);

      appendContext(row, snapshot);

      // A restored turn must resolve N1 from its own snapshot, not from the
      // live targets — node order can differ from when it was asked.
      const refMap = snapshot
        ? new Map(snapshot.nodes.map((node) => [node.tag, node.id] as const))
        : this.aiNumberMap;

      const body = row.createDiv({ cls: "volis-ai-reply" });
      await MarkdownRenderer.render(this.app, this.decorateAnswer(text, refMap), body, "", this);
      this.linkAnswerRefs(body, refMap);

      const bar = row.createDiv({ cls: "volis-ai-reply-bar" });
      appendCopy(bar, text);

      if (selectable) {
        row.addEventListener("click", (evt) => {
          if (!window.getSelection()?.isCollapsed) return;
          if ((evt.target as HTMLElement).closest("details, button")) return;
          evt.preventDefault();
          togglePick(index);
        });
        if (this.aiPicked.size === 0) this.aiPicked.add(index);
      }

      refreshPicks();
      scrollDown();
      return body;
    };

    /** All picked answers, joined in dialogue order. */
    const currentAnswer = (): string => {
      const indexes = Array.from(this.aiPicked).sort((a, b) => a - b);
      return indexes
        .map((index) => this.aiAnswers[index])
        .filter((value): value is string => Boolean(value))
        .join("\n\n");
    };

    const thinkingLines = [
      "正在读你的卡片…",
      "CPU 疯狂燃烧🔥…",
      "脑细胞集合中…",
      "组织语言中…",
    ];

    const addPending = (snapshot: AISendSnapshot | null): {
      row: HTMLElement;
      stop: () => void;
      say: (text: string) => void;
    } => {
      const row = stream.createDiv({ cls: "volis-ai-msg is-status" });
      const contextLabel = appendContext(row, snapshot);

      // The rotating status replaces "已读取上下文"; node/token counts stay put.
      const label = contextLabel ?? row.createSpan({
        cls: "volis-ai-thinking",
        text: thinkingLines[0],
      });
      label.setText(thinkingLines[0]);

      let step = 0;
      const timer = window.setInterval(() => {
        step = (step + 1) % thinkingLines.length;
        label.setText(thinkingLines[step]);
      }, 1500);

      const stop = () => window.clearInterval(timer);

      // Long answers are continued in segments; tell the user instead of
      // letting the spinner look stuck.
      const say = (text: string) => {
        stop();
        label.setText(text);
        scrollDown();
      };

      scrollDown();
      return { row, stop, say };
    };

    /** Failures stay in the stream as a quiet, expandable message. */
    const addError = (text: string, retry: () => void): void => {
      const row = stream.createDiv({ cls: "volis-ai-msg is-error" });

      const body = row.createDiv({ cls: "volis-ai-error" });
      body.createDiv({ cls: "volis-ai-error-title", text: "请求未成功" });
      body.createDiv({ cls: "volis-ai-error-summary", text });

      const details = body.createEl("details", { cls: "volis-ai-error-detail" });
      details.createEl("summary", { text: "查看原因" });
      const pre = details.createEl("pre", { text });
      pre.createEl("span", {
        cls: "volis-ai-error-hint",
        text: "可检查该模型的输出上限、思考模式或接口地址后重试。",
      });

      const bar = body.createDiv({ cls: "volis-ai-reply-bar" });
      const retryBtn = bar.createEl("button", { cls: "volis-ai-reply-icon" });
      setIcon(retryBtn, "rotate-ccw");
      retryBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        retry();
      });

      scrollDown();
    };

    const setBusy = (value: boolean) => {
      this.aiBusy = value;

      input.disabled = value;
      sendBtn.empty();
      setIcon(sendBtn, value ? "square" : "arrow-up");
      sendBtn.toggleClass("is-stop", value);
      sendBtn.setAttribute("aria-label", value ? "停止生成" : "发送");

      if (value) {
        insertBtn.disabled = true;
        noteBtn.disabled = true;
        overwriteBtn.disabled = true;
      } else {
        syncActions();
      }
    };

    const ask = async () => {
      const question = input.value.trim();
      if (!question || this.aiBusy || !this.aiProvider) return;

      input.value = "";
      addUserBubble(question);
      this.aiCancelled = false;
      setBusy(true);

      // Each turn keeps the exact snapshot it was sent with.
      const snapshot: AISendSnapshot | null = this.aiManifest
        ? {
            usedTokens: this.aiManifest.usedTokens,
            stage: this.aiManifest.stage,
            nodes: this.aiManifest.nodes.map((node) => ({
              id: node.id,
              tag: node.tag,
              label: node.label,
              charsSent: node.charsSent,
              charsTotal: node.charsTotal,
              truncated: node.truncated,
              readable: node.readable,
              note: node.note,
            })),
            notes: [...this.aiManifest.notes],
          }
        : null;

      const pending = addPending(snapshot);
      this.aiPending = pending;

      const aiSettings = this.plugin.settings.ai;
      const thinking = this.resolveThinking(profile);
      // Anthropic caches the stable prefix; OpenAI-compatible providers do it
      // on their own, so no marker is needed there.
      const cache = profile?.protocol === "anthropic" && profile?.cache !== false;
      let outCap = profile?.capability?.maxOutput ?? 8192;

      // Rebuild only if a node changed while the panel was open.
      this.ensureSystem(profile);
      await this.compactHistory(profile);

      // A trimmed turn says so once; the full detail lives in the reply block.
      if (snapshot && snapshot.notes.length > 0) {
        new Notice(`本次已读取上下文：${snapshot.notes.join("；")}`.slice(0, 160));
      }

      this.aiHistory.push({ role: "user", content: question });

      let result: AIResult | null = null;
      let capDoubled = false;

      try {
        for (;;) {
          try {
            result = await this.aiProvider.complete(this.aiHistory, {
              system: this.aiSystem,
              maxTokens: outCap,
              thinking,
              cache,
            });
            break;
          } catch (error) {
            // Thinking can eat the whole budget and leave no text at all.
            // One retry with a bigger paper is cheaper than a failed turn.
            if (!capDoubled && isThinkingBudgetError(error) && outCap < 32768) {
              capDoubled = true;
              outCap = Math.min(32768, outCap * 2);
              pending.say(`思考占满了额度，用 ${formatTokens(outCap)} 重试一次…`);
              continue;
            }
            throw error;
          }
        }

        if (!result) throw new Error("请求没有返回结果");

        let reply = result.text;
        let rounds = 0;
        let continueFailed = false;

        // A long answer hits the per-request cap mid-sentence. Continue it
        // instead of handing the user half a plan they must ask for again.
        while (result.truncated && rounds < aiSettings.continuations && !this.aiCancelled) {
          rounds += 1;
          pending.say(`回答较长，正在续写第 ${rounds} 段…`);

          try {
            result = await this.aiProvider.complete(
              [
                ...this.aiHistory,
                { role: "assistant", content: reply },
                { role: "user", content: CONTINUE_PROMPT },
              ],
              { system: this.aiSystem, maxTokens: outCap, thinking, cache }
            );
          } catch (error) {
            // Keep the first half instead of throwing the whole answer away.
            continueFailed = true;
            break;
          }

          const merged = mergeContinuation(reply, result.text);
          // No real new text means the model had nothing more to add.
          if (merged.length <= reply.length + 8) break;
          reply = merged;
        }

        // Close quotes and emphasis left open by the cut, once, at the end.
        if (result.truncated || rounds > 0) reply = balanceTail(reply);

        this.aiHistory.push({ role: "assistant", content: reply });

        pending.stop();
        pending.row.remove();
        this.aiPending = null;

        if (this.aiCancelled) {
          this.aiHistory.pop();
          this.aiHistory.pop();
          return;
        }

        await addAiBubble(reply, snapshot);
        this.persistConversation(question);

        if (continueFailed) {
          new Notice("续写失败，这次答复可能不完整");
        } else if (result.truncated) {
          new Notice("回答仍被长度上限截断，可在模型配置里调大「单次输出上限」");
        }

        insertBtn.disabled = false;
        noteBtn.disabled = false;
        if (overwriteTarget) overwriteBtn.disabled = false;
      } catch (error) {
        // Drop the unanswered turn so a retry does not carry a dangling user message.
        this.aiHistory.pop();
        pending.stop();
        pending.row.remove();
        this.aiPending = null;
        if (!this.aiCancelled) {
          const failedQuestion = question;
          addError(error instanceof Error ? error.message : String(error), () => {
            input.value = failedQuestion;
            void ask();
          });
        }
      } finally {
        setBusy(false);
        input.focus();
      }
    };

    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Escape") {
        evt.preventDefault();
        this.closeAiPanel();
        return;
      }
      if (evt.key === "Enter") {
        evt.preventDefault();
        void ask();
      }
    });

    sendBtn.addEventListener("click", () => {
      if (this.aiBusy) {
        this.aiCancelled = true;
        this.aiPending?.stop();
        this.aiPending?.row.remove();
        this.aiPending = null;
        setBusy(false);
        new Notice("已停止生成");
        return;
      }
      void ask();
    });

    newBtn.addEventListener("click", () => {
      this.aiConversationId = null;
      this.aiHistory = [];
      this.aiAnswers = [];
      this.aiSnapshots = [];
      this.aiPicked = new Set<number>();
      stream.empty();
      stream.createDiv({ cls: "volis-ai-empty-hint", text: "新对话已开始，选中的节点保持不变。" });
      insertBtn.disabled = true;
      noteBtn.disabled = true;
      if (overwriteTarget) overwriteBtn.disabled = true;
      input.focus();
    });

    this.aiRestore = (conv: StoredConversation) => {
      stream.empty();

      const answers = conv.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.content);

      // `addAiBubble` pushes into `aiAnswers` itself. Start empty so the array
      // indexes line up with the rows it renders — otherwise every restored
      // answer is stored twice and the action bar counts two for one click.
      this.aiAnswers = [];
      this.aiSnapshots = [];
      this.aiPicked = new Set<number>();

      // Show the numbers this conversation actually used, so the badges line up
      // with references in its answers even if the board order has changed.
      const firstSnapshot = conv.messages.find(
        (message) => message.role === "assistant" && message.send
      )?.send;
      if (firstSnapshot) {
        this.aiNumberMap = new Map(
          firstSnapshot.nodes.map((node) => [node.tag, node.id] as const)
        );
        this.applyNodeNumbers();
      }

      for (const message of conv.messages) {
        if (message.role === "user") {
          addUserBubble(message.content);
          continue;
        }
        void addAiBubble(message.content, message.send ?? null, true);
      }

      // A restored conversation starts with nothing picked. Picking the last
      // answer up front makes the next click add a second one.
      this.aiPicked.clear();
      refreshPicks();
      scrollDown();
    };

    historyBtn.addEventListener("click", () => this.openHistoryPop(historyBtn));

    expandBtn.addEventListener("click", () => {
      this.aiExpanded = !this.aiExpanded;
      panel.toggleClass("is-expanded", this.aiExpanded);
      setIcon(expandBtn, this.aiExpanded ? "minimize-2" : "maximize-2");
      place();
    });

    closeBtn.addEventListener("click", () => this.closeAiPanel());

    insertBtn.addEventListener("click", () => {
      const text = currentAnswer();
      if (!text) return;
      void this.insertAIText(text, this.aiTargets);
      this.closeAiPanel();
    });

    noteBtn.addEventListener("click", () => {
      const text = currentAnswer();
      if (!text) return;
      void createNoteFromText(
        this.app,
        this.plugin.settings.boardFolder ?? "",
        text,
        "AI 整理"
      ).then((file) => {
        if (file) new Notice(`已保存为 ${file.basename}`);
      });
      this.closeAiPanel();
    });

    overwriteBtn.addEventListener("click", () => {
      if (!overwriteTarget) return;

      const text = this.replyTextForOverwrite();
      if (!text) return;

      const indexes = Array.from(this.aiPicked).sort((a, b) => a - b);
      const scope =
        indexes.length === 1
          ? `第 ${indexes[0] + 1} 条回答`
          : `选中的 ${indexes.length} 条回答（按顺序合并）`;
      const targetName =
        overwriteTarget.type === "card"
          ? "卡片（会同时改写速记里的原文）"
          : overwriteTarget.type === "file"
            ? "这篇笔记的全文"
            : "这个文本节点";

      new ConfirmModal(
        this.app,
        "覆盖原节点内容？",
        `将用${scope}覆盖${targetName}。原有内容会被替换，可按 Ctrl+Z 撤销。`,
        "确认覆盖",
        () => {
          void this.overwriteNode(overwriteTarget, text).then((ok) => {
            if (ok) {
              new Notice("已覆盖原节点内容，可按 Ctrl+Z 撤销");
              this.closeAiPanel();
            } else {
              new Notice("覆盖失败");
            }
          });
        }
      ).open();
    });


    window.setTimeout(() => input.focus(), 30);
  }

  private stripContext(content: string): string {
    const marker = "【问题】\n";
    const index = content.indexOf(marker);
    return index >= 0 ? content.slice(index + marker.length) : content;
  }

  private persistConversation(question: string): void {
    const boardPath = this.file?.path ?? "";
    if (!boardPath) return;

    const store = this.plugin.settings.conversations;
    let conversation = store.find((item) => item.id === this.aiConversationId);

    if (!conversation) {
      conversation = {
        id: `c${Date.now()}`,
        title: question.replace(/\s+/g, " ").trim().slice(0, 24) || "未命名对话",
        boardPath,
        updatedAt: Date.now(),
        messages: [],
        nodeIds: [],
      };
      store.push(conversation);
      this.aiConversationId = conversation.id;
    }

    let answerIndex = 0;
    conversation.messages = this.aiHistory.map((message) => {
      if (message.role === "user") {
        return { role: "user" as const, content: this.stripContext(message.content) };
      }
      const snapshot = this.aiSnapshots[answerIndex] ?? undefined;
      answerIndex += 1;
      return { role: "assistant" as const, content: message.content, ...(snapshot ? { send: snapshot } : {}) };
    });
    conversation.updatedAt = Date.now();
    conversation.nodeIds = this.aiTargets.map((node) => node.id);

    // Newest first, capped so the settings file cannot grow without bound.
    this.plugin.settings.conversations = store
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 30);

    void this.plugin.saveSettings();
  }

  private async loadConversation(conversation: StoredConversation): Promise<void> {
    this.aiConversationId = conversation.id;
    this.aiHistory = conversation.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));

    const alive = conversation.nodeIds
      .map((id) => this.nodeMap.get(id))
      .filter((node): node is BoardNode => Boolean(node));

    // Older conversations only stored the group id, so expand it again here:
    // the members are still on the board and must be visible when asking on.
    if (alive.length > 0) this.aiTargets = this.expandGroups(alive);

    // The restored targets may differ from the ones the panel opened with.
    this.ensureSystem(activeProfile(this.plugin.settings.ai), true);
    this.applyNodeNumbers();

    this.aiRestore?.(conversation);

    if (alive.length < conversation.nodeIds.length) {
      new Notice("部分节点已不存在，这次对话只能查看，追问时 AI 看不到它们");
    }
  }

  private deleteConversation(id: string): void {
    const store = this.plugin.settings.conversations.filter((item) => item.id !== id);
    this.plugin.settings.conversations = store;
    if (this.aiConversationId === id) this.aiConversationId = null;
    void this.plugin.saveSettings();
  }

  private closeHistoryPop(): void {
    if (this.historyOutside) {
      document.removeEventListener("mousedown", this.historyOutside, true);
      this.historyOutside = null;
    }
    this.historyPop?.remove();
    this.historyPop = null;
  }

  private formatStamp(timestamp: number): string {
    const date = new Date(timestamp);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  private openHistoryPop(anchor: HTMLElement): void {
    const wasOpen = Boolean(this.historyPop);
    this.closeHistoryPop();
    if (wasOpen) return;

    const boardPath = this.file?.path ?? "";
    const items = this.plugin.settings.conversations
      .filter((conversation) => conversation.boardPath === boardPath)
      .sort((a, b) => b.updatedAt - a.updatedAt);

    const pop = this.root.createDiv({ cls: "volis-ai-history" });
    this.historyPop = pop;
    pop.addEventListener("pointerdown", (evt) => evt.stopPropagation());
    pop.addEventListener("dblclick", (evt) => evt.stopPropagation());

    const head = pop.createDiv({ cls: "volis-ai-history-head" });
    head.createDiv({ cls: "volis-ai-history-heading", text: "对话记录" });

    if (items.length > 0) {
      const clear = head.createEl("button", { cls: "volis-ai-history-clear", text: "全部删除" });
      clear.addEventListener("click", () => {
        new ConfirmModal(
          this.app,
          "删除全部对话记录？",
          `将删除这块白板的 ${items.length} 条记录，无法恢复。`,
          "全部删除",
          () => {
            this.plugin.settings.conversations = this.plugin.settings.conversations.filter(
              (conversation) => conversation.boardPath !== boardPath
            );
            this.aiConversationId = null;
            void this.plugin.saveSettings();
            this.closeHistoryPop();
          }
        ).open();
      });
    }

    if (items.length === 0) {
      pop.createDiv({ cls: "volis-ai-history-empty", text: "这块白板还没有对话记录" });
    }

    for (const conversation of items) {
      const row = pop.createDiv({ cls: "volis-ai-history-item" });
      if (conversation.id === this.aiConversationId) row.addClass("is-current");

      const iconEl = row.createDiv({ cls: "volis-ai-history-icon" });
      setIcon(iconEl, "message-square");

      const body = row.createDiv({ cls: "volis-ai-history-body" });
      body.createDiv({ cls: "volis-ai-history-name", text: conversation.title });
      body.createDiv({
        cls: "volis-ai-history-time",
        text: this.formatStamp(conversation.updatedAt),
      });

      const del = row.createEl("button", {
        cls: "volis-ai-history-del",
        attr: { "aria-label": "删除这条记录" },
      });
      setIcon(del, "trash-2");

      del.addEventListener("click", (evt) => {
        evt.stopPropagation();
        this.deleteConversation(conversation.id);
        this.closeHistoryPop();
        this.openHistoryPop(anchor);
      });

      row.addEventListener("click", () => {
        this.closeHistoryPop();
        void this.loadConversation(conversation);
      });
    }

    const anchorRect = anchor.getBoundingClientRect();
    const panelEl = anchor.closest<HTMLElement>(".volis-ai-panel");
    const panelRect = panelEl?.getBoundingClientRect() ?? anchorRect;
    const rootRect = this.root.getBoundingClientRect();
    const width = 300;
    const gap = 8;

    // Align to the panel's right edge, not to the button, so it hugs the window.
    pop.style.left = `${Math.round(
      Math.max(gap, Math.min(panelRect.right - rootRect.left - width - gap, rootRect.width - width - gap))
    )}px`;
    pop.style.top = `${Math.round(anchorRect.bottom - rootRect.top + 6)}px`;

    this.historyOutside = (evt: MouseEvent) => {
      const target = evt.target as Node | null;
      if (target && (pop.contains(target) || anchor.contains(target))) return;
      this.closeHistoryPop();
    };
    document.addEventListener("mousedown", this.historyOutside, true);
  }

  /**
   * Turns bare references like N3 into N3「content preview」. The lookup uses
   * the explicit N→id map, never the targets array: a selected group occupies
   * a slot there and would shift every number by one.
   */
  private decorateAnswer(text: string, map: Map<string, string>): string {
    return text.replace(/\bN(\d+)\b/g, (match, digits: string) => {
      const nodeId = map.get(`N${digits}`);
      if (!nodeId) return match;

      const preview = (this.nodeText.get(nodeId) ?? "").replace(/\s+/g, " ").trim();
      if (!preview) return match;

      const short = preview.length > 12 ? `${preview.slice(0, 12)}…` : preview;
      return `${match}「${short}」`;
    });
  }

  /**
   * After Markdown is rendered, turn N1「…」 into a clickable reference. Doing
   * this on the DOM keeps the copied answer as plain Markdown.
   */
  private linkAnswerRefs(host: HTMLElement, map: Map<string, string>): void {
    if (map.size === 0) return;

    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    while (walker.nextNode()) texts.push(walker.currentNode as Text);

    const pattern = /\b(N\d+)「[^」]*」/g;

    for (const textNode of texts) {
      const value = textNode.textContent ?? "";
      const matches = Array.from(value.matchAll(pattern));
      if (matches.length === 0) continue;

      const fragment = document.createDocumentFragment();
      let cursor = 0;

      for (const match of matches) {
        const index = match.index ?? 0;
        if (index > cursor) {
          fragment.appendChild(document.createTextNode(value.slice(cursor, index)));
        }

        const tag = match[1];
        const nodeId = map.get(tag);
        if (!nodeId) {
          fragment.appendChild(document.createTextNode(match[0]));
        } else {
          const button = document.createElement("button");
          button.className = "volis-ai-nref";
          button.type = "button";
          button.textContent = match[0];
          button.addEventListener("click", (evt) => {
            evt.stopPropagation();
            evt.preventDefault();
            this.jumpToNumberedNode(nodeId);
          });
          fragment.appendChild(button);
        }

        cursor = index + match[0].length;
      }

      if (cursor < value.length) {
        fragment.appendChild(document.createTextNode(value.slice(cursor)));
      }
      textNode.parentNode?.replaceChild(fragment, textNode);
    }
  }

  /** Centre and briefly highlight the node an answer referred to. */
  private jumpToNumberedNode(nodeId: string): void {
    const node = this.nodeMap.get(nodeId);
    if (!node || !this.nodeEls.has(nodeId)) {
      new Notice("这个节点已经不在当前白板上了");
      return;
    }
    this.centerOnNode(node);
  }

  /** Selected text inside the panel, otherwise the latest full answer. */
  private replyTextForOverwrite(): string {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? "";

    if (text && selection?.anchorNode && this.aiPanel?.contains(selection.anchorNode)) {
      return text;
    }

    return Array.from(this.aiPicked)
      .sort((a, b) => a - b)
      .map((index) => this.aiAnswers[index])
      .filter((value): value is string => Boolean(value))
      .join("\n\n");
  }

  /**
   * A card lives inside a single list item, so blank lines and nested Markdown
   * would break the block apart. This keeps the meaning but makes the result
   * storable as one contiguous block.
   */
  private flattenForCard(text: string): string {
    const out: string[] = [];

    for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
      const line = raw.trim();
      if (!line) continue;

      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      if (heading) {
        out.push(`**${heading[1].replace(/\*\*/g, "")}**`);
        continue;
      }

      const bullet = /^[-*+]\s+(.*)$/.exec(line);
      if (bullet) {
        out.push(`• ${bullet[1]}`);
        continue;
      }

      const rule = /^([-*_])\1{2,}$/.test(line);
      if (rule) continue;

      out.push(line);
    }

    return out.join("\n");
  }

  private async overwriteNode(node: BoardNode, text: string): Promise<boolean> {
    const content = text.trim();
    if (!content) return false;

    if (node.type === "text") {
      node.text = content;
      await this.renderNode(node);
    } else if (node.type === "card") {
      const ref = { file: node.file, blockId: node.blockId, linkpath: "" };
      const meta = await readCard(this.app, ref);

      // The time prefix is what marks a block as a card; dropping it makes the
      // card disappear from the card list even though the content is intact.
      const ok = await writeCard(
        this.app,
        ref,
        `${meta.timePrefix}${this.flattenForCard(content)}`
      );
      if (!ok) return false;
      await this.renderNode(node);
    } else if (node.type === "file") {
      const file = this.app.vault.getAbstractFileByPath(node.file);
      if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") return false;
      await this.app.vault.modify(file, content);
      await this.renderNode(node);
    } else {
      return false;
    }

    this.pushHistory();
    this.scheduleSave();
    return true;
  }

  private centerWorld(): { x: number; y: number } {
    const rect = this.root.getBoundingClientRect();
    return this.toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  /** Directly creates a new text node, optionally as a yellow sticky. */
  private async createTextAtCenter(sticky = false): Promise<void> {
    const point = this.centerWorld();
    const node: TextNode = {
      id: createId(),
      type: "text",
      text: "",
      x: Math.round(point.x - DEFAULT_CARD_WIDTH / 2),
      y: Math.round(point.y - 24),
      width: DEFAULT_CARD_WIDTH,
    };

    if (sticky) node.sticky = true;

    this.nodes.push(node);
    this.nodeMap.set(node.id, node);

    this.selection.clear();
    this.selection.add(node.id);

    const el = await this.renderNode(node);
    this.paintSelection();
    this.updateHint();
    this.pushHistory();
    this.scheduleSave();
    void this.openEditor(node, el);
  }

  private async createStickyAtCenter(): Promise<void> {
    await this.createTextAtCenter(true);
  }

  private async insertAIText(text: string, targets: BoardNode[]): Promise<void> {
    const box = this.selectionBox(targets);
    const anchor = box ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };

    const node: TextNode = {
      id: createId(),
      type: "text",
      text,
      x: Math.round(anchor.maxX + 40),
      y: Math.round(anchor.minY),
      width: 360,
    };

    this.nodes.push(node);
    this.nodeMap.set(node.id, node);

    await this.renderNode(node);

    this.selection.clear();
    this.selection.add(node.id);
    this.paintSelection();
    this.updateHint();
    this.pushHistory();
    this.scheduleSave();
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

    // Drag by the header. The input and everything below stay interactive.
    let dragOrigin: { x: number; y: number; left: number; top: number } | null = null;

    head.addEventListener("pointerdown", (evt) => {
      if ((evt.target as HTMLElement).closest("input, button")) return;

      dragOrigin = {
        x: evt.clientX,
        y: evt.clientY,
        left: panel.offsetLeft,
        top: panel.offsetTop,
      };

      head.setPointerCapture(evt.pointerId);
      panel.addClass("is-dragging");
    });

    head.addEventListener("pointermove", (evt) => {
      if (!dragOrigin) return;
      panel.style.left = `${Math.round(dragOrigin.left + evt.clientX - dragOrigin.x)}px`;
      panel.style.top = `${Math.round(dragOrigin.top + evt.clientY - dragOrigin.y)}px`;
    });

    const endDrag = (evt: PointerEvent) => {
      if (!dragOrigin) return;
      dragOrigin = null;
      panel.removeClass("is-dragging");
      try {
        head.releasePointerCapture(evt.pointerId);
      } catch (error) {
        // capture already released
      }
    };

    head.addEventListener("pointerup", endDrag);
    head.addEventListener("pointercancel", endDrag);

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

  public openInsertPanelAtCenter(filter?: InsertFilter): void {
    const rect = this.root.getBoundingClientRect();
    const world = this.toWorld(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2
    );
    void this.openInsertPanel(world, null, null, filter);
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
    fromSide: PortSide | null,
    filter?: InsertFilter
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

    // Drag by the header. The input and everything below stay interactive.
    let dragOrigin: { x: number; y: number; left: number; top: number } | null = null;

    head.addEventListener("pointerdown", (evt) => {
      if ((evt.target as HTMLElement).closest("input, button")) return;

      dragOrigin = {
        x: evt.clientX,
        y: evt.clientY,
        left: panel.offsetLeft,
        top: panel.offsetTop,
      };

      head.setPointerCapture(evt.pointerId);
      panel.addClass("is-dragging");
    });

    head.addEventListener("pointermove", (evt) => {
      if (!dragOrigin) return;
      panel.style.left = `${Math.round(dragOrigin.left + evt.clientX - dragOrigin.x)}px`;
      panel.style.top = `${Math.round(dragOrigin.top + evt.clientY - dragOrigin.y)}px`;
    });

    const endDrag = (evt: PointerEvent) => {
      if (!dragOrigin) return;
      dragOrigin = null;
      panel.removeClass("is-dragging");
      try {
        head.releasePointerCapture(evt.pointerId);
      } catch (error) {
        // capture already released
      }
    };

    head.addEventListener("pointerup", endDrag);
    head.addEventListener("pointercancel", endDrag);

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
          item.kind === "card"
            ? "list"
            : item.kind === "note"
              ? "file-text"
              : item.kind === "media"
                ? "image"
                : "type"
        );

        const body = row.createDiv({ cls: "volis-insert-item-body" });
        body.createDiv({ cls: "volis-insert-title", text: item.title });
        body.createDiv({ cls: "volis-insert-sub", text: item.sub });

        row.addEventListener("click", () => void choose(index));
      });
    };

    const reload = async (query: string) => {
      const mine = ++token;
      const found = await searchInsertItems(
        this.app,
        this.plugin.settings.cardFolder,
        query,
        filter
      );
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
      // A searched result already points at a real note; only the panel's
      // "新建空白笔记" entry has no file and needs one created.
      if (item.file) {
        created = await this.addFileNode(item.file, world);
      } else {
        const folder = this.plugin.settings.boardFolder ?? "";
        const file = await createNoteFromText(this.app, folder, "", "未命名");
        if (file) created = await this.addFileNode(file.path, world);
      }
    } else if (item.kind === "media" && item.file) {
      created = await this.addFileNode(item.file, world);
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

    this.edgeRelationBtn = bar.createEl("button", {
      cls: "volis-tool-btn",
      attr: { "aria-label": "设置关系" },
    });
    setIcon(this.edgeRelationBtn, "git-branch");
    this.edgeRelationBtn.addEventListener("click", () => {
      if (this.selectedEdgeId) this.openEdgeLabelEditor(this.selectedEdgeId, undefined, "relation");
    });

    this.edgeLabelBtn = bar.createEl("button", {
      cls: "volis-tool-btn",
      attr: { "aria-label": "添加标签" },
    });
    setIcon(this.edgeLabelBtn, "tag");
    this.edgeLabelBtn.addEventListener("click", () => {
      if (this.selectedEdgeId) this.openEdgeLabelEditor(this.selectedEdgeId);
    });

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

    // The label editor sits on the very same midpoint, so the bar steps aside
    // while it is open instead of crowding it.
    if (!this.selectedEdgeId || this.edgeLabelEditor) {
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

    if (this.edgeLabelBtn) {
      this.edgeLabelBtn.setAttribute(
        "aria-label",
        this.edgeLabelOf(edge) ? "修改标签" : "添加标签"
      );
    }

    if (this.edgeRelationBtn) {
      const meta = edge.relation ? EDGE_RELATION_BY_ID.get(edge.relation) : undefined;
      this.edgeRelationBtn.setAttribute("aria-label", meta ? `关系：${meta.label}` : "设置关系");
      const color = this.lineColorOf(edge.color) ?? this.lineColorOf(meta?.color);
      this.edgeRelationBtn.style.color = color ?? "";
    }

    const rect = this.root.getBoundingClientRect();

    // Same anchor as the label: one geometry source for both.
    // Same anchor as the chip: one geometry source for both.
    const curve = this.edgeGeometry(edge);
    const anchor = curve ? curvePoint(curve, this.edgeLabelT(edge)) : { x: 0, y: 0 };

    const screenX = anchor.x * this.scale + this.tx;
    const screenY = anchor.y * this.scale + this.ty;

    const width = bar.offsetWidth || 240;
    const height = bar.offsetHeight || 36;

    const left = Math.max(8, Math.min(screenX - width / 2, rect.width - width - 8));
    // Sit above the chip rather than on top of it when the line is labelled.
    const chipLift = this.edgeDisplayLabel(edge) ? (EDGE_LABEL_HEIGHT / 2) * this.scale : 0;
    const top = Math.max(8, screenY - height - 12 - chipLift);

    bar.style.left = `${Math.round(left)}px`;
    bar.style.top = `${Math.round(top)}px`;
  }

  /**
   * Inline editor for a connection's relation and label, anchored in world
   * space on the label's point on the line. Enter commits, Escape cancels,
   * clicking away commits.
   *
   * `at` is the board point the user aimed at (a double-click on the line); it
   * is projected onto the curve and becomes the label's position. Without it
   * the label keeps the position it already has, or lands in the middle.
   * `focus` decides which control receives focus when the popup opens.
   */
  private openEdgeLabelEditor(
    edgeId: string,
    at?: Point,
    focus: "label" | "relation" = "label"
  ): void {
    const edge = this.edges.find((item) => item.id === edgeId);
    if (!edge) return;

    const curve = this.edgeGeometry(edge);
    if (!curve) return;

    const t = at ? clampLabelT(nearestCurveT(curve, at)) : this.edgeLabelT(edge);

    this.closeEdgeLabelEditor(true);

    const wrap = this.world.createDiv({ cls: "volis-edge-label-editor" });
    wrap.addEventListener("pointerdown", (evt) => evt.stopPropagation());
    wrap.addEventListener("dblclick", (evt) => evt.stopPropagation());

    const select = wrap.createEl("select", {
      cls: "volis-edge-relation-select",
      attr: { "aria-label": "连线关系" },
    });
    select.createEl("option", { text: "无关系", value: "" });
    for (const meta of EDGE_RELATIONS) {
      select.createEl("option", { text: meta.label, value: meta.id });
    }
    select.value = edge.relation ?? "";

    const input = wrap.createEl("input", {
      cls: "volis-edge-label-input",
      attr: {
        type: "text",
        placeholder: "输入标签",
        maxlength: String(EDGE_LABEL_MAX),
        spellcheck: "false",
      },
    });
    input.value = this.edgeLabelOf(edge);

    const onKeydown = (evt: KeyboardEvent) => {
      evt.stopPropagation();
      // Enter while an IME is composing confirms the candidate, not the field.
      if (evt.isComposing) return;

      if (evt.key === "Enter") {
        evt.preventDefault();
        this.closeEdgeLabelEditor(true);
      } else if (evt.key === "Escape") {
        evt.preventDefault();
        this.closeEdgeLabelEditor(false);
      }
    };
    input.addEventListener("keydown", onKeydown);
    select.addEventListener("keydown", onKeydown);

    // Commit only when focus leaves the whole editor. An input-only blur closed
    // the popup as soon as the relation select was clicked.
    wrap.addEventListener("focusout", (evt) => {
      const next = evt.relatedTarget as Node | null;
      if (next && wrap.contains(next)) return;
      this.closeEdgeLabelEditor(true);
    });

    this.edgeLabelEditor = { el: wrap, input, select, edgeId, t };
    this.syncEdgeLabelEditor();
    if (focus === "relation") {
      select.focus();
    } else {
      input.focus();
      input.select();
    }
    this.updateEdgeBar();
  }

  /**
   * Pins the field to the label's point on the line and cancels the board zoom,
   * so the input stays a normal, readable size however far the board is scaled.
   * The chip under it scales with the board, but a text field that shrinks to a
   * few pixels would be unusable.
   */
  private syncEdgeLabelEditor(): void {
    const editor = this.edgeLabelEditor;
    if (!editor) return;

    const edge = this.edges.find((item) => item.id === editor.edgeId);
    const curve = edge ? this.edgeGeometry(edge) : null;
    if (curve) {
      const anchor = curvePoint(curve, editor.t);
      editor.el.style.left = `${Math.round(anchor.x)}px`;
      editor.el.style.top = `${Math.round(anchor.y)}px`;
    }

    editor.el.style.transform = `translate(-50%, -50%) scale(${1 / this.scale})`;
  }

  private closeEdgeLabelEditor(commit: boolean): void {
    const editor = this.edgeLabelEditor;
    if (!editor) return;

    // Cleared first: removing the element can fire focusout, which would loop
    // back into this method and commit twice.
    this.edgeLabelEditor = null;
    const value = editor.input.value;
    const relation = editor.select.value
      ? (editor.select.value as EdgeRelation)
      : undefined;
    editor.el.remove();

    if (commit) this.commitEdgeEdit(editor.edgeId, value, editor.t, relation);
    // Bring the style bar back now that it no longer has to make room.
    this.updateEdgeBar();
  }

  private commitEdgeEdit(
    edgeId: string,
    raw: string,
    t: number,
    relation?: EdgeRelation
  ): void {
    const edge = this.edges.find((item) => item.id === edgeId);
    if (!edge) return;

    const value = raw.trim().slice(0, EDGE_LABEL_MAX);
    const position = clampLabelT(t);
    // Reopening a label without typing must not count as an edit, but dragging
    // it to a new spot on the line must.
    const moved = Math.abs(position - this.edgeLabelT(edge)) > 0.001;
    const relationChanged = edge.relation !== relation;
    if (value === this.edgeLabelOf(edge) && !moved && !relationChanged) return;

    if (value) {
      edge.label = value;
      edge.labelAt = position;
    } else {
      delete edge.label;
      // A relation on its own still draws a chip, so it keeps the spot the
      // user picked. Only a connection with neither text nor relation loses
      // its position.
      if (relation) edge.labelAt = position;
      else delete edge.labelAt;
    }

    if (relationChanged) {
      if (relation) {
        edge.relation = relation;
        // Switching relation applies that relation's visual language. Colour
        // and arrow remain individually overridable from the edge bar.
        delete edge.color;
        delete edge.style;
        delete edge.arrow;
      } else {
        delete edge.relation;
      }
    }

    this.renderEdges();
    this.updateEdgeBar();
    this.pushHistory();
    this.scheduleSave();
  }

  /**
   * Selecting is a class toggle, never a re-render. Rebuilding the SVG here
   * would replace the very path the user just pressed, and the browser drops
   * the second click of a double-click when the two clicks land on different
   * elements — which is why double-clicking a line did nothing at all.
   */
  private selectEdge(edgeId: string): void {
    this.selectedEdgeId = edgeId;
    this.selection.clear();
    this.paintSelection();
    this.paintEdgeSelection();
    this.updateEdgeBar();
  }

  private paintEdgeSelection(): void {
    const groups = this.edgesEl?.querySelectorAll<SVGGElement>(".volis-edge-group");
    if (!groups) return;

    for (const group of Array.from(groups)) {
      group.classList.toggle("is-selected", group.dataset.edgeId === this.selectedEdgeId);
    }
  }

  private deleteSelectedEdge(): boolean {
    if (!this.selectedEdgeId) return false;

    if (this.edgeLabelEditor?.edgeId === this.selectedEdgeId) {
      this.closeEdgeLabelEditor(false);
    }

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
      const play = el.querySelector<HTMLElement>(".volis-bnode-play");
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
      this.paintEdgeSelection();
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
    this.updateOutlineActive();
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

    // Connection first: without this a double-click on a line would fall
    // through to the canvas and spawn a text node at that spot.
    const group = target.closest(".volis-edge-group");
    const edgeId = group?.getAttribute("data-edge-id") ?? null;
    if (edgeId) {
      // Double-clicking the label itself edits it where it stands; anywhere
      // else on the line puts the label under the pointer.
      const onChip = target.closest(".volis-edge-label-bg, .volis-edge-label") !== null;
      this.openEdgeLabelEditor(
        edgeId,
        onChip ? undefined : this.toWorld(evt.clientX, evt.clientY)
      );
      return;
    }

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
    void this.openEditor(node, el);
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

    const block = plain.match(/!?\[\[([^[\]|#]+)#\^([^\]|\n]+)(?:\|[^\]\n]+)?\]\]/);
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
      const basePath = String((this.app.vault.adapter as unknown as { basePath?: string }).basePath ?? "").replace(/\\/g, "/");
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

      const config = (this.app.vault as unknown as { getConfig?: (key: string) => unknown }).getConfig?.("attachmentFolderPath");
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

  private toggleOutlinePanel(): void {
    if (this.outlinePanel) {
      this.closeOutlinePanel();
      return;
    }
    this.openOutlinePanel();
  }

  /** Opens the floating outline. Public so a command can reach it directly. */
  openOutlinePanel(): void {
    if (this.outlinePanel) {
      this.renderOutlinePanel();
      return;
    }

    const panel = this.root.createDiv({ cls: "volis-outline-panel" });
    panel.style.left = `${this.outlinePos.left}px`;
    panel.style.top = `${this.outlinePos.top}px`;
    panel.addEventListener("pointerdown", (evt) => evt.stopPropagation());
    panel.addEventListener("dblclick", (evt) => evt.stopPropagation());
    // The list scrolls itself; without this the board would zoom instead.
    panel.addEventListener("wheel", (evt) => evt.stopPropagation(), { passive: true });

    const head = panel.createDiv({ cls: "volis-outline-head" });
    const headIcon = head.createDiv({ cls: "volis-outline-head-icon" });
    setIcon(headIcon, "list-tree");
    head.createDiv({ cls: "volis-outline-head-title", text: "大纲" });
    this.outlineMetaEl = head.createDiv({ cls: "volis-outline-head-meta" });
    head.createDiv({ cls: "volis-outline-head-spacer" });

    const closeBtn = head.createEl("button", {
      cls: "volis-outline-head-btn",
      attr: { "aria-label": "关闭" },
    });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => this.closeOutlinePanel());

    this.outlineBodyEl = panel.createDiv({ cls: "volis-outline-body" });
    this.outlinePanel = panel;
    this.installOutlineDrag(panel, head);

    this.outlineSignatureCache = "";
    this.renderOutlinePanel();
    this.outlineSignatureCache = this.outlineSignature();
  }

  private closeOutlinePanel(): void {
    if (this.outlineTimer !== null) {
      window.clearTimeout(this.outlineTimer);
      this.outlineTimer = null;
    }
    if (this.outlinePanel) {
      this.outlinePos = {
        left: this.outlinePanel.offsetLeft,
        top: this.outlinePanel.offsetTop,
      };
      this.outlinePanel.remove();
    }
    this.outlinePanel = null;
    this.outlineBodyEl = null;
    this.outlineMetaEl = null;
  }

  private installOutlineDrag(panel: HTMLElement, head: HTMLElement): void {
    let start: { x: number; y: number; left: number; top: number } | null = null;

    head.addEventListener("pointerdown", (evt) => {
      if ((evt.target as HTMLElement).closest("button")) return;
      start = {
        x: evt.clientX,
        y: evt.clientY,
        left: panel.offsetLeft,
        top: panel.offsetTop,
      };
      head.setPointerCapture(evt.pointerId);
      panel.addClass("is-dragging");
    });

    head.addEventListener("pointermove", (evt) => {
      if (!start) return;
      panel.style.left = `${Math.round(start.left + evt.clientX - start.x)}px`;
      panel.style.top = `${Math.round(start.top + evt.clientY - start.y)}px`;
    });

    const end = (evt: PointerEvent) => {
      if (!start) return;
      start = null;
      panel.removeClass("is-dragging");
      try {
        head.releasePointerCapture(evt.pointerId);
      } catch (error) {
        // pointer already released
      }
    };

    head.addEventListener("pointerup", end);
    head.addEventListener("pointercancel", end);
  }

  private renderOutlinePanel(): void {
    const body = this.outlineBodyEl;
    if (!body) return;

    const scrollTop = body.scrollTop;
    body.empty();

    const inputs: OutlineNodeInput[] = this.nodes.map((node) => ({
      id: node.id,
      x: node.x,
      y: node.y,
      kind: node.type,
    }));

    const result = buildOutline(inputs, this.edges, (input) => this.outlineInfoOf(input));

    if (result.nodeCount === 0) {
      body.createDiv({
        cls: "volis-outline-empty",
        text: "白板上还没有节点。新建卡片或便签后，这里会按结构列出它们。",
      });
      this.updateOutlineMeta(result);
      return;
    }

    for (const item of result.roots) {
      this.renderOutlineItem(body, item, 0);
    }

    if (result.cycle) {
      body.createDiv({
        cls: "volis-outline-note",
        text: "检测到循环的推导/因果关系，环上的一条连线已在大纲中跳过。",
      });
    } else if (!result.hasHierarchy) {
      body.createDiv({
        cls: "volis-outline-note",
        text: "还没有推导或因果连线，节点按位置平铺。给连线设置「推导」或「因果」即可生成层级。",
      });
    }

    this.updateOutlineMeta(result);
    body.scrollTop = scrollTop;
  }

  private updateOutlineMeta(result: OutlineResult): void {
    if (!this.outlineMetaEl) return;
    const parts = [`${result.nodeCount} 个节点`];
    if (result.hasHierarchy) parts.push(result.hasSequence ? "分层 + 顺序" : "分层");
    else parts.push("平铺");
    this.outlineMetaEl.setText(parts.join(" · "));
  }

  private renderOutlineItem(host: HTMLElement, item: OutlineItem, depth: number): void {
    const collapsed = this.outlineCollapsed.has(item.id);
    const row = host.createDiv({ cls: "volis-outline-row" });
    row.dataset.nodeId = item.id;
    row.toggleClass("is-root", depth === 0);
    row.toggleClass("is-active", this.selection.has(item.id));
    row.toggleClass("is-group", item.kind === "group");

    if (item.children.length > 0) {
      const toggle = row.createEl("button", {
        cls: "volis-outline-toggle",
        attr: { "aria-label": collapsed ? "展开" : "折叠" },
      });
      setIcon(toggle, collapsed ? "chevron-right" : "chevron-down");
      toggle.addEventListener("click", (evt) => {
        evt.stopPropagation();
        if (collapsed) this.outlineCollapsed.delete(item.id);
        else this.outlineCollapsed.add(item.id);
        this.renderOutlinePanel();
      });
    } else {
      row.createDiv({ cls: "volis-outline-toggle is-empty" });
    }

    const main = row.createDiv({ cls: "volis-outline-main" });
    const titleRow = main.createDiv({ cls: "volis-outline-title-row" });
    const title = titleRow.createDiv({ cls: "volis-outline-title", text: item.title });
    title.setAttribute("title", item.title);

    if (item.relation) {
      titleRow.createSpan({
        cls: `volis-outline-relation is-${item.relation}`,
        text: item.relation === "derives" ? "推导" : "因果",
      });
    }

    const badges = titleRow.createDiv({ cls: "volis-outline-badges" });
    if (item.badges.supports > 0) {
      badges.createSpan({
        cls: "volis-outline-badge is-supports",
        text: `支持 ${item.badges.supports}`,
      });
    }
    if (item.badges.refutes > 0) {
      badges.createSpan({
        cls: "volis-outline-badge is-refutes",
        text: `反驳 ${item.badges.refutes}`,
      });
    }
    if (item.badges.source > 0) {
      badges.createSpan({
        cls: "volis-outline-badge is-source",
        text: `来源 ${item.badges.source}`,
      });
    }

    if (item.snippet) {
      main.createDiv({ cls: "volis-outline-snippet", text: item.snippet });
    }

    row.addEventListener("click", () => this.focusNodeInBoard(item.id));

    if (collapsed || item.children.length === 0) return;
    // A real container per level keeps the guide line continuous and
    // makes the hierarchy readable without absolute pixel offsets.
    const kids = host.createDiv({ cls: "volis-outline-children" });
    for (const child of item.children) {
      this.renderOutlineItem(kids, child, depth + 1);
    }
  }

  private focusNodeInBoard(nodeId: string): void {
    const node = this.nodeMap.get(nodeId);
    if (!node) return;

    const el = this.nodeEls.get(nodeId);
    const height = el?.offsetHeight ?? node.height ?? 100;
    const rect = this.root.getBoundingClientRect();

    const centerX = node.x + node.width / 2;
    const centerY = node.y + height / 2;
    this.tx = rect.width / 2 - centerX * this.scale;
    this.ty = rect.height / 2 - centerY * this.scale;

    this.selectedEdgeId = null;
    this.selection.clear();
    this.selection.add(nodeId);

    this.paintSelection();
    this.paintEdgeSelection();
    this.applyTransform();
    this.updateHint();
    this.scheduleSave();
  }

  private updateOutlineActive(): void {
    if (!this.outlinePanel) return;
    const rows = this.outlinePanel.querySelectorAll<HTMLElement>(".volis-outline-row");
    rows.forEach((row) => {
      row.toggleClass(
        "is-active",
        !!row.dataset.nodeId && this.selection.has(row.dataset.nodeId)
      );
    });
  }

  private scheduleOutlineRefresh(): void {
    if (!this.outlinePanel) return;
    if (this.outlineTimer !== null) window.clearTimeout(this.outlineTimer);
    this.outlineTimer = window.setTimeout(() => {
      this.outlineTimer = null;
      if (!this.outlinePanel) return;
      const signature = this.outlineSignature();
      if (signature === this.outlineSignatureCache) return;
      this.outlineSignatureCache = signature;
      this.renderOutlinePanel();
    }, 220);
  }

  private outlineSignature(): string {
    const nodes = this.nodes
      .map((node) => {
        const label = node.type === "group" ? node.label ?? "" : "";
        return `${node.id}@${Math.round(node.x)},${Math.round(node.y)}:${node.type}:${label}`;
      })
      .join("|");

    const edges = this.edges
      .map((edge) => `${edge.from}>${edge.to}:${edge.relation ?? ""}`)
      .join("|");

    const text = this.nodes
      .map((node) => (this.nodeText.get(node.id) ?? "").slice(0, 120))
      .join("|");

    return `${nodes}##${edges}##${text}`;
  }

  /** Opens the Markdown export dialog. Public so a command can reach it. */
  openExportModal(): void {
    const inputs: OutlineNodeInput[] = this.nodes.map((node) => ({
      id: node.id,
      x: node.x,
      y: node.y,
      kind: node.type,
    }));
    const result = buildOutline(inputs, this.edges, (input) => this.outlineInfoOf(input));

    const infoById = new Map<string, ExportNodeInfo>();
    const collect = (items: OutlineItem[]): void => {
      for (const item of items) {
        infoById.set(item.id, this.exportInfoOf(item));
        collect(item.children);
      }
    };
    collect(result.roots);

    new MarkdownExportModal(this.app, {
      boardTitle: this.file?.basename ?? "白板",
      nodeCount: result.nodeCount,
      build: (format) =>
        buildExportMarkdown(
          {
            boardTitle: this.file?.basename ?? "白板",
            outline: result,
            infoOf: (id) => infoById.get(id) ?? { title: "未命名", body: "" },
            edges: this.edges,
            titleOf: (id) => infoById.get(id)?.title ?? this.exportTitleOf(id),
          },
          format
        ),
      save: (markdown) => this.saveExportNote(markdown),
    }).open();
  }

  private exportTitleOf(id: string): string {
    const node = this.nodeMap.get(id);
    if (!node) return "未命名";
    return this.outlineInfoOf({ id, x: node.x, y: node.y, kind: node.type }).title;
  }

  private exportInfoOf(item: OutlineItem): ExportNodeInfo {
    const node = this.nodeMap.get(item.id);
    if (!node || node.type === "group") return { title: item.title, body: "" };

    // A file node stands for a note that already exists. Exporting the link
    // keeps one copy of the text instead of pasting a whole note into a note.
    if (node.type === "file") {
      return { title: item.title, body: `[[${node.file}|${item.title}]]` };
    }

    const full = this.nodeText.get(node.id) ?? (node.type === "text" ? node.text : "");
    return { title: item.title, body: this.exportBody(full) };
  }

  /** The first line already became the heading; the rest is the body. */
  private exportBody(text: string): string {
    const lines = text.split(/\r?\n/);
    const first = lines.findIndex((line) => line.trim() !== "");
    if (first === -1) return "";
    return lines.slice(first + 1).join("\n").trim();
  }

  private async saveExportNote(markdown: string): Promise<string> {
    const boardPath = this.file?.path ?? "";
    const folder = boardPath.includes("/") ? boardPath.slice(0, boardPath.lastIndexOf("/")) : "";
    const base = (this.file?.basename ?? "白板").replace(/[\\/:*?"<>|]/g, " ").trim() || "白板";
    const adapter = this.app.vault.adapter;

    let name = `${base}.md`;
    let path = folder ? `${folder}/${name}` : name;
    let index = 1;
    while (await adapter.exists(path)) {
      name = `${base} ${index}.md`;
      path = folder ? `${folder}/${name}` : name;
      index += 1;
    }

    const file = await this.app.vault.create(path, markdown);
    return file.path;
  }

  private outlineInfoOf(node: OutlineNodeInput): OutlineInfo {
    const source = this.nodeMap.get(node.id);
    if (!source) return { title: "未命名" };

    if (source.type === "group") {
      return { title: source.label?.trim() || "未命名分组" };
    }

    if (source.type === "file") {
      const file = this.app.vault.getAbstractFileByPath(source.file);
      const name =
        file instanceof TFile ? file.basename : source.file.split("/").pop() ?? "文件";
      const body = this.nodeText.get(source.id);
      const snippet = body ? this.outlineSnippet(body) : "";
      return { title: name, snippet: snippet || undefined };
    }

    const text =
      this.nodeText.get(source.id) ?? (source.type === "text" ? source.text : "");
    return this.outlineTextInfo(text);
  }

  private outlineTextInfo(text: string): OutlineInfo {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return { title: "未命名" };

    const cleaned = lines.map((line) => this.outlineClean(line)).filter(Boolean);
    if (cleaned.length === 0) return { title: "未命名" };

    const title = cleaned[0];
    const snippet = cleaned.slice(1).join(" ");
    return {
      title: this.outlineTruncate(title, 40),
      snippet: snippet ? this.outlineTruncate(snippet, 70) : undefined,
    };
  }

  private outlineSnippet(text: string): string {
    const lines = text
      .split(/\r?\n/)
      .map((line) => this.outlineClean(line))
      .filter(Boolean);
    return lines.length > 1 ? this.outlineTruncate(lines.slice(1).join(" "), 70) : "";
  }

  /** Strips the Markdown that would only add noise in a one-line outline. */
  private outlineClean(raw: string): string {
    return raw
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s*>\s?/, "")
      .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, "")
      .replace(/^\s*[-*+]\s+/, "")
      .replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, alias?: string) => {
        if (alias) return alias;
        const clean = target.split("#")[0];
        return clean.split("/").pop() || target;
      })
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\*\*|__|~~/g, "")
      .replace(/(^|\s)#[\p{L}\p{N}_/-]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private outlineTruncate(text: string, max: number): string {
    const chars = Array.from(text);
    return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
  }

  private scheduleSave(): void {
    if (!this.loaded) return;
    this.scheduleOutlineRefresh();
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
