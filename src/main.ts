import { Notice, Plugin, TFile } from "obsidian";
import { DEFAULT_SETTINGS, VolisSettings, normalizeAISettings } from "./settings";
import { NodeIndex, collectNodes } from "./canvas/nodeIndex";
import { ActionContext, ActionRegistry } from "./canvas/actions";
import { SyncEngine } from "./canvas/syncEngine";
import { applyBadges, clearBadges } from "./canvas/badge";
import { BoardView, VIEW_TYPE_VOLIS_BOARD } from "./board/BoardView";
import {
  LEGACY_BOARD_PATH,
  listBoards,
  loadBoardFile,
  nextBoardPath,
} from "./board/boardStore";
import { BoardPickerModal } from "./board/boardPicker";
import { ContextMenuInjector } from "./canvas/contextMenu";
import { CardEditorModal } from "./ui/cardEditor";
import { InlineEditor } from "./ui/inlineEditor";
import { writeCard } from "./store/cardStore";
import { makeBlockLink } from "./parse/cardRef";
import { CardMeta } from "./types";
import { VolisSettingTab } from "./settingsTab";

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
    this.addRibbonIcon("layout-dashboard", "新建卡片白板", () => {
      void this.createBoard();
    });

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

    // Carry the previous single-board data over once, so nothing is lost.
    let initial = JSON.stringify({ version: 1, nodes: [] }, null, 2);
    if (listBoards(this.app).length === 0) {
      const legacy = await loadBoardFile(this.app, LEGACY_BOARD_PATH);
      if (legacy && legacy.nodes.length > 0) {
        initial = JSON.stringify(legacy, null, 2);
      }
    }

    const file = await this.app.vault.create(path, initial);
    await this.openBoardFile(file.path);
  }

  async openBoardFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    // Same rule as opening any note: jump to the tab that already shows it.
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_VOLIS_BOARD)) {
      const view: any = leaf.view;
      if (view?.file?.path === file.path) {
        this.app.workspace.revealLeaf(leaf);
        return;
      }
    }

    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    this.app.workspace.revealLeaf(leaf);
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
    const data = (await this.loadData()) ?? {};
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...data,
      ai: normalizeAISettings((data as { ai?: unknown }).ai),
      conversations: Array.isArray((data as { conversations?: unknown }).conversations)
        ? ((data as { conversations: never[] }).conversations)
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

  private ensureObserver(view: any): void {
    const container: HTMLElement | undefined = view?.containerEl;
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

  private getCanvasView(): any | null {
    const candidates: any[] = [];
    const active: any = this.app.workspace.activeLeaf;
    if (active) candidates.push(active);
    const recent: any = (this.app.workspace as any).getMostRecentLeaf?.();
    if (recent) candidates.push(recent);
    for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
      candidates.push(leaf);
    }

    for (const leaf of candidates) {
      const view: any = leaf?.view;
      if (view && typeof view.getViewType === "function" && view.getViewType() === "canvas") {
        return view;
      }
    }
    return null;
  }

  private selfCheck(): void {
    const view = this.getCanvasView();
    const canvas = view?.canvas;
    const nodes = canvas?.nodes;
    const info: Record<string, unknown> = {
      version: this.manifest.version,
      hasCanvasView: !!view,
      hasCanvas: !!canvas,
      hasNodesMap: !!nodes,
      nodeCount: nodes?.size ?? 0,
      recognized: this.index.size,
    };

    if (nodes && nodes.size > 0) {
      const first: any = Array.from(nodes.values())[0];
      const data = typeof first?.getData === "function" ? first.getData() : null;
      info.firstNode = {
        keys: data ? Object.keys(data) : [],
        type: data?.type,
        text: data?.text,
        hasNodeEl: !!first?.nodeEl,
        nodeElClass: first?.nodeEl?.className ?? null,
      };
    }

    console.log("[Volis] self-check", info);
    new Notice(
      `Volis 自检 · 画布:${info.hasCanvasView ? "有" : "无"} · 节点:${info.nodeCount} · 识别:${info.recognized}`,
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
    const canvas = view?.canvas;
    if (!canvas) return null;

    const selection: any[] = Array.from(canvas.selection ?? []);
    if (selection.length === 0) return null;

    const first: any = selection[0];
    const id: string | undefined =
      first?.id ?? (typeof first?.getData === "function" ? first.getData?.()?.id : undefined);
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

        const nodeEl = target.closest(".canvas-node") as HTMLElement | null;
        if (!nodeEl) {
          this.pendingClick = null;
          return;
        }

        const view = this.getCanvasView();
        if (!view) return;

        const node = this.findNodeByElement(view, nodeEl);
        const nodeId: string | undefined = node?.getData?.()?.id;
        if (!nodeId) return;

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

  private findNodeByElement(view: any, el: HTMLElement): any | null {
    for (const node of collectNodes(view?.canvas?.nodes)) {
      const nodeEl: HTMLElement | undefined = node?.nodeEl;
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
        if (view) view.openAIPanel();
      },
    });

    this.addCommand({
      id: "find-node",
      name: "在白板中查找节点",
      callback: () => {
        const view = this.getCanvasView();
        if (view) view.openNodeSearch();
      },
    });

    this.addCommand({
      id: "insert-node",
      name: "搜索或新建节点",
      callback: () => {
        const view = this.getCanvasView();
        if (view) view.openInsertPanelAtCenter();
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
    let node: any = nodeId ? canvas?.nodes?.get?.(nodeId) : null;

    if (!node) {
      for (const candidate of collectNodes(canvas?.nodes)) {
        const entry = this.index.get(candidate?.getData?.()?.id);
        const ref = entry?.meta?.ref;
        if (ref && ref.file === meta.ref.file && ref.blockId === meta.ref.blockId) {
          node = candidate;
          break;
        }
      }
    }

    const nodeEl: HTMLElement | undefined = node?.nodeEl;
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
    const canvas = ctx.canvasView?.canvas;
    const node = canvas?.nodes?.get?.(ctx.nodeId);
    try {
      if (node && typeof canvas.removeNode === "function") {
        canvas.removeNode(node);
      } else if (node && typeof node.remove === "function") {
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

function isNodeSelected(view: any, node: any, nodeId: string): boolean {
  const selection: any = view?.canvas?.selection;
  if (!selection) return false;

  if (typeof selection.has === "function") {
    try {
      if (selection.has(node)) return true;
    } catch (error) {
      // some builds store ids instead of node objects
    }
  }

  let found = false;
  if (typeof selection.forEach === "function") {
    selection.forEach((item: any) => {
      const id =
        item?.id ?? (typeof item?.getData === "function" ? item.getData?.()?.id : undefined);
      if (id === nodeId) found = true;
    });
  }
  return found;
}
