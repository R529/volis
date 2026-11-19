import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS, StoredConversation, VolisSettings, normalizeAISettings } from "./settings";
import { NodeIndex } from "./canvas/nodeIndex";
import { ActionContext, ActionRegistry } from "./canvas/actions";
import { SyncEngine } from "./canvas/syncEngine";
import { applyBadges, clearBadges } from "./canvas/badge";
import { BoardView, VIEW_TYPE_VOLIS_BOARD } from "./board/BoardView";
import { blankBoardData, listBoards, nextBoardPath } from "./board/boardStore";
import { BoardPickerModal } from "./board/boardPicker";
import { ContextMenuInjector } from "./canvas/contextMenu";
import { CardEditorModal } from "./ui/cardEditor";
import { InlineEditor } from "./ui/inlineEditor";
import { writeCard } from "./store/cardStore";
import { makeBlockLink } from "./parse/cardRef";
import { CardMeta } from "./types";
import { VolisSettingTab } from "./settingsTab";
import { CanvasNodeData, CanvasNodeLike, CanvasViewLike, collectNodes } from "./canvas/canvasTypes";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

/** Dashed canvas, a flowing stroke and a node dot. Built as DOM, not HTML text,
 *  so the ribbon icon stays safe under the community scanner. */
function paintRibbonIcon(host: HTMLElement): void {
  host.empty();
  const svg = svgEl("svg", {
    xmlns: SVG_NS,
    viewBox: "0 0 24 24",
    width: "18",
    height: "18",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.8",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  svg.append(
    svgEl("rect", {
      x: "2.5", y: "3.5", width: "19", height: "17", rx: "5",
      "stroke-dasharray": "3 2.6",
    }),
    svgEl("path", {
      d: "M6 15.5C8.2 10.5 11 10.2 11.8 12.4C12.6 14.6 15.4 14.8 17.6 10.2",
    }),
    svgEl("circle", {
      cx: "18.6", cy: "6.6", r: "1.5", fill: "currentColor", stroke: "none",
    })
  );
  host.appendChild(svg);
}

export default class VolisPlugin extends Plugin {
  settings!: VolisSettings;

  private index!: NodeIndex;
  private registry!: ActionRegistry;
  private sync!: SyncEngine;

  private observer: MutationObserver | null = null;
  private observedContainer: HTMLElement | null = null;
  private timer: number | null = null;
  private painting = false;
  private lastPaintAt = 0;
  private suppressDblClickUntil = 0;
  private pendingClick: {
    nodeId: string;
    nodeEl: HTMLElement;
    x: number;
    y: number;
    wasSelected: boolean;
  } | null = null;
  private editingCount = 0;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.index = new NodeIndex(this.app);
    this.registry = new ActionRegistry();
    this.sync = new SyncEngine(
      this.app,
      () => {
        this.index.clear();
        this.scheduleRefresh(120);
      },
      () => this.editingCount === 0
    );

    this.registerActions();
    new ContextMenuInjector(this.app, this.registry, (nodeId) => this.buildContext(nodeId)).install(this);

    this.addSettingTab(new VolisSettingTab(this.app, this));
    this.registerCommands();
    this.registerWatchers();
    this.installInlineEditing();

    this.registerView(VIEW_TYPE_VOLIS_BOARD, (leaf) => new BoardView(leaf, this));
    this.registerExtensions(["volis"], VIEW_TYPE_VOLIS_BOARD);
    // Drawn by hand instead of a library icon, so it cannot collide with the
    // stock shapes every canvas-style plugin reuses.
    const ribbon = this.addRibbonIcon("dot", "Volis", () => {
      void this.createBoard();
    });
    paintRibbonIcon(ribbon);

    this.app.workspace.onLayoutReady(() => {
      this.scheduleRefresh(300);
    });
  }

  async openBoard(): Promise<void> {
    const boards = listBoards(this.app);
    if (boards.length === 0) {
      await this.createBoard();
      return;
    }

    new BoardPickerModal(this.app, (file) => {
      void this.openBoardFile(file.path);
    }).open();
  }

  async createBoard(): Promise<void> {
    const folder = this.settings.boardFolder ?? "";
    const path = await nextBoardPath(this.app, folder);

    // A new board is always blank, including the very first one. An old
    // hidden board file, if any, is left alone rather than silently imported.
    const file = await this.app.vault.create(
      path,
      JSON.stringify(blankBoardData(), null, 2)
    );
    await this.openBoardFile(file.path);
  }

  async openBoardFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    // Same rule as opening any note: jump to the tab that already shows it.
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_VOLIS_BOARD)) {
      const view = leaf.view as unknown as CanvasViewLike;
      if (view.file?.path === file.path) {
        void this.app.workspace.revealLeaf(leaf);
        return;
      }
    }

    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    void this.app.workspace.revealLeaf(leaf);
  }

  onunload(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    const view = this.getCanvasView();
    if (view) clearBadges(view);
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<VolisSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(loaded ?? {}),
      ai: normalizeAISettings(loaded?.ai),
      conversations: Array.isArray(loaded?.conversations)
        ? loaded.conversations
        : [],
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.scheduleRefresh(150);
  }

  recognizedCount(): number {
    return this.index.size;
  }

  scheduleRefresh(delay = 250): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.refreshCanvas();
    }, delay);
  }

  private async refreshCanvas(): Promise<void> {
    if (this.editingCount > 0) return;

    const view = this.getCanvasView();
    if (!view) return;

    try {
      this.ensureObserver(view);
      await this.index.scan(view);

      if (this.painting) return;
      this.painting = true;
      this.lastPaintAt = Date.now();
      try {
        applyBadges(view, this.index, this.settings);
      } finally {
        this.painting = false;
      }
    } catch (error) {
      console.error("[Volis] refresh failed", error);
    }
  }

  private ensureObserver(view: CanvasViewLike): void {
    const container = view.containerEl;
    if (!container) return;
    if (this.observer && this.observedContainer === container) return;

    if (this.observer) this.observer.disconnect();

    this.observedContainer = container;
    this.observer = new MutationObserver(() => {
      if (this.painting) return;
      if (Date.now() - this.lastPaintAt < 600) return;
      this.scheduleRefresh(400);
    });
    this.observer.observe(container, { childList: true, subtree: true });
    this.register(() => {
      if (this.observer) this.observer.disconnect();
    });
  }

  private getCanvasView(): CanvasViewLike | null {
    const workspace = this.app.workspace as unknown as {
      activeLeaf: WorkspaceLeaf | null;
      getMostRecentLeaf?: () => WorkspaceLeaf | null;
    };
    const candidates: WorkspaceLeaf[] = [];
    if (workspace.activeLeaf) candidates.push(workspace.activeLeaf);
    const recent = workspace.getMostRecentLeaf?.();
    if (recent) candidates.push(recent);
    for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
      candidates.push(leaf);
    }

    for (const leaf of candidates) {
      const view = leaf?.view as unknown as CanvasViewLike | null;
      if (view && typeof view.getViewType === "function" && view.getViewType() === "canvas") {
        return view;
      }
    }
    return null;
  }

  private selfCheck(): void {
    const view = this.getCanvasView();
    const canvas = view?.canvas;
    const nodes = canvas?.nodes ? collectNodes(canvas.nodes) : [];

    console.warn("[Volis] self-check", {
      version: this.manifest.version,
      hasCanvasView: !!view,
      hasCanvas: !!canvas,
      hasNodesMap: !!canvas?.nodes,
      nodeCount: nodes.length,
      recognized: this.index.size,
    });

    const first = nodes[0];
    if (first) {
      const data: CanvasNodeData =
        typeof first.getData === "function"
          ? (first.getData() ?? {})
          : (first as unknown as CanvasNodeData);
      console.warn("[Volis] first node", {
        keys: Object.keys(data),
        type: data.type,
        text: data.text,
        hasNodeEl: !!first.nodeEl,
        nodeElClass: first.nodeEl?.className ?? null,
      });
    }

    new Notice(
      `Volis 自检 · 画布:${view ? "有" : "无"} · 节点:${nodes.length} · 识别:${this.index.size}`,
      10000
    );
  }

  private buildContext(nodeId: string): ActionContext | null {
    const view = this.getCanvasView();
    if (!view) return null;
    const entry = this.index.get(nodeId);
    if (!entry) return null;
    return { app: this.app, entry, canvasView: view, nodeId };
  }

  private getSelectedContext(): ActionContext | null {
    const view = this.getCanvasView();
    const selection = view?.canvas?.selection;
    if (!selection) return null;

    const items = Array.from(selection);
    if (items.length === 0) return null;

    const first = items[0];
    const id = first.id ?? first.getData?.()?.id;
    if (!id) return null;

    return this.buildContext(id);
  }

  private installInlineEditing(): void {
    this.registerDomEvent(
      document,
      "mousedown",
      (evt: MouseEvent) => {
        if (evt.button !== 0) return;
        const target = evt.target as HTMLElement | null;
        if (!target) return;
        if (target.closest(".volis-inline")) return;

        const nodeEl = target.closest<HTMLElement>(".canvas-node");
        if (!nodeEl) {
          this.pendingClick = null;
          return;
        }

        const view = this.getCanvasView();
        if (!view) return;

        const node = this.findNodeByElement(view, nodeEl);
        const nodeId = node?.getData?.()?.id ?? node?.id;
        if (!node || !nodeId) return;

        const meta = this.index.get(nodeId)?.meta;
        if (!meta || meta.stale) return;

        this.pendingClick = {
          nodeId,
          nodeEl,
          x: evt.clientX,
          y: evt.clientY,
          wasSelected: isNodeSelected(view, node, nodeId),
        };
      },
      true
    );

    this.registerDomEvent(
      document,
      "mouseup",
      (evt: MouseEvent) => {
        const pending = this.pendingClick;
        this.pendingClick = null;
        if (!pending || evt.button !== 0) return;

        const distance = Math.hypot(evt.clientX - pending.x, evt.clientY - pending.y);
        if (distance > 6) return;
        if (!pending.wasSelected) return;

        const meta = this.index.get(pending.nodeId)?.meta;
        if (!meta || meta.stale) return;

        this.openInline(pending.nodeEl, meta, evt.clientY);
      },
      true
    );

    this.registerDomEvent(
      document,
      "dblclick",
      (evt: MouseEvent) => {
        if (Date.now() >= this.suppressDblClickUntil) return;
        evt.preventDefault();
        evt.stopPropagation();
      },
      true
    );

    this.registerDomEvent(
      document,
      "click",
      (evt: MouseEvent) => {
        if (Date.now() >= this.suppressDblClickUntil) return;
        const target = evt.target as HTMLElement | null;
        if (target?.closest(".volis-inline")) return;
        evt.preventDefault();
        evt.stopPropagation();
      },
      true
    );
  }

  private findNodeByElement(
    view: CanvasViewLike,
    el: HTMLElement
  ): CanvasNodeLike | null {
    for (const node of collectNodes(view.canvas?.nodes)) {
      const nodeEl = node.nodeEl;
      if (!nodeEl) continue;
      if (nodeEl === el || nodeEl.contains(el)) return node;
    }
    return null;
  }

  private openInline(nodeEl: HTMLElement, meta: CardMeta, clickY?: number): void {
    this.suppressDblClickUntil = Date.now() + 400;
    this.editingCount += 1;

    new InlineEditor(
      nodeEl,
      meta.editable,
      async (value) => {
        if (!value.trim()) {
          new Notice("内容为空，未保存");
          this.scheduleRefresh(0);
          return;
        }
        const next = meta.timePrefix + value;
        if (next === meta.body) return;
        const ok = await writeCard(this.app, meta.ref, next);
        if (!ok) {
          new Notice("保存失败：卡片可能已移动或删除");
          return;
        }
        this.index.clear();
        this.scheduleRefresh(60);
      },
      () => undefined,
      clickY,
      () => {
        this.editingCount = Math.max(0, this.editingCount - 1);
        if (this.editingCount === 0) {
          this.sync.flushPending();
          this.scheduleRefresh(250);
        }
      }
    );
  }

  private registerWatchers(): void {
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scheduleRefresh(150)));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleRefresh(150)));
    this.registerEvent(this.app.workspace.on("file-open", () => this.scheduleRefresh(150)));
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file instanceof TFile) this.sync.handleModify(file);
      })
    );
  }

  private registerCommands(): void {
    this.addCommand({
      id: "ai-analyze",
      name: "用 AI 分析白板",
      callback: () => {
        const view = this.getCanvasView();
        if (view) view.openAIPanel?.();
      },
    });

    this.addCommand({
      id: "board-doctor",
      name: "白板体检",
      callback: () => {
        const view = this.getCanvasView();
        if (view) view.openBoardDoctor?.();
      },
    });

    this.addCommand({
      id: "board-outline",
      name: "打开白板大纲",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(BoardView);
        if (!view) return false;
        if (!checking) view.openOutlinePanel?.();
        return true;
      },
    });

    this.addCommand({
      id: "board-export-markdown",
      name: "导出白板为 Markdown",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(BoardView);
        if (!view) return false;
        if (!checking) view.openExportModal?.();
        return true;
      },
    });

    this.addCommand({
      id: "find-node",
      name: "在白板中查找节点",
      callback: () => {
        const view = this.getCanvasView();
        if (view) view.openNodeSearch?.();
      },
    });

    this.addCommand({
      id: "insert-node",
      name: "搜索或新建节点",
      callback: () => {
        const view = this.getCanvasView();
        if (view) view.openInsertPanelAtCenter?.();
      },
    });

    this.addCommand({
      id: "open-card-board",
      name: "打开已有白板",
      callback: () => {
        void this.openBoard();
      },
    });

    this.addCommand({
      id: "new-card-board",
      name: "新建空白白板",
      callback: () => {
        void this.createBoard();
      },
    });

    this.addCommand({
      id: "self-check",
      name: "自检",
      callback: () => this.selfCheck(),
    });

    this.addCommand({
      id: "refresh-cards",
      name: "刷新当前画布的卡片",
      checkCallback: (checking) => {
        const view = this.getCanvasView();
        if (!view) return false;
        if (!checking) this.scheduleRefresh(0);
        return true;
      },
    });

    this.addCommand({
      id: "edit-selected-card",
      name: "编辑选中的卡片",
      checkCallback: (checking) => {
        const ctx = this.getSelectedContext();
        if (!ctx) return false;
        const meta = ctx.entry.meta;
        if (!meta || meta.stale) return false;
        if (!checking) this.editCard(meta, ctx.nodeId);
        return true;
      },
    });

    this.addCommand({
      id: "locate-selected-card",
      name: "在笔记中定位选中的卡片",
      checkCallback: (checking) => {
        const ctx = this.getSelectedContext();
        if (!ctx) return false;
        const meta = ctx.entry.meta;
        if (!meta || meta.stale) return false;
        if (!checking) void this.locateCard(meta);
        return true;
      },
    });

    this.addCommand({
      id: "copy-selected-block-link",
      name: "复制选中卡片的块链接",
      checkCallback: (checking) => {
        const ctx = this.getSelectedContext();
        if (!ctx) return false;
        const meta = ctx.entry.meta;
        if (!meta) return false;
        if (!checking) {
          void navigator.clipboard.writeText(makeBlockLink(meta.ref)).then(() => {
            new Notice("已复制块链接");
          });
        }
        return true;
      },
    });
  }

  private registerActions(): void {
    this.registry.register({
      id: "edit-card",
      label: "编辑卡片内容",
      group: "card",
      icon: "pencil",
      available: (ctx) => !!ctx.entry.meta && !ctx.entry.meta.stale,
      run: (ctx) => {
        if (ctx.entry.meta) this.editCard(ctx.entry.meta, ctx.nodeId);
      },
    });

    this.registry.register({
      id: "locate-card",
      label: "在笔记中定位",
      group: "card",
      icon: "crosshair",
      available: (ctx) => !!ctx.entry.meta && !ctx.entry.meta.stale,
      run: (ctx) => {
        if (ctx.entry.meta) void this.locateCard(ctx.entry.meta);
      },
    });

    this.registry.register({
      id: "copy-block-link",
      label: "复制块链接",
      group: "card",
      icon: "link",
      available: (ctx) => !!ctx.entry.meta,
      run: async (ctx) => {
        if (!ctx.entry.meta) return;
        await navigator.clipboard.writeText(makeBlockLink(ctx.entry.meta.ref));
        new Notice("已复制块链接");
      },
    });

    this.registry.register({
      id: "refresh-node",
      label: "刷新该节点",
      group: "diagnostic",
      icon: "refresh-cw",
      run: () => this.scheduleRefresh(0),
    });

    this.registry.register({
      id: "remove-stale-node",
      label: "移除失效节点",
      group: "diagnostic",
      icon: "trash-2",
      available: (ctx) => {
        const meta = ctx.entry.meta;
        return !meta || meta.stale;
      },
      run: (ctx) => this.removeNode(ctx),
    });
  }

  private editCard(meta: CardMeta, nodeId?: string): void {
    const view = this.getCanvasView();
    const canvas = view?.canvas;
    let node: CanvasNodeLike | null = nodeId ? (canvas?.get?.(nodeId) ?? null) : null;

    if (!node) {
      for (const candidate of collectNodes(canvas?.nodes)) {
        const entry = this.index.get(candidate.getData?.()?.id ?? candidate.id ?? "");
        const ref = entry?.meta?.ref;
        if (ref && ref.file === meta.ref.file && ref.blockId === meta.ref.blockId) {
          node = candidate;
          break;
        }
      }
    }

    const nodeEl = node?.nodeEl;
    if (nodeEl) {
      this.openInline(nodeEl, meta);
      return;
    }

    new CardEditorModal(this.app, meta, async (value) => {
      const ok = await writeCard(this.app, meta.ref, value);
      if (ok) this.scheduleRefresh(150);
      return ok;
    }).open();
  }

  private async locateCard(meta: CardMeta): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(meta.ref.file);
    if (!(file instanceof TFile)) {
      new Notice("找不到源文件");
      return;
    }
    const cache = this.app.metadataCache.getFileCache(file);
    const line = cache?.blocks?.[meta.ref.blockId]?.position?.start?.line ?? 0;
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file, { eState: { line } });
  }

  private removeNode(ctx: ActionContext): void {
    const canvas = ctx.canvasView.canvas;
    const node = canvas?.get?.(ctx.nodeId) ?? null;
    try {
      if (node && canvas?.removeNode) {
        canvas.removeNode(node);
      } else if (node?.remove) {
        node.remove();
      } else {
        return;
      }
      this.scheduleRefresh(150);
    } catch (error) {
      new Notice("无法移除该节点");
    }
  }
}

function isNodeSelected(
  view: CanvasViewLike,
  node: CanvasNodeLike,
  nodeId: string
): boolean {
  const selection = view.canvas?.selection;
  if (!selection) return false;

  if (selection instanceof Set && selection.has(node)) return true;

  for (const item of Array.from(selection)) {
    const id = item.id ?? item.getData?.()?.id;
    if (id === nodeId) return true;
  }
  return false;
}
