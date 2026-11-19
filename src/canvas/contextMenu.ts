import { App, EventRef, Menu, Plugin } from "obsidian";
import { ActionContext, ActionRegistry } from "./actions";
import { CanvasNodeData, CanvasNodeLike } from "./canvasTypes";

export class ContextMenuInjector {
  constructor(
    private app: App,
    private registry: ActionRegistry,
    private resolveContext: (nodeId: string) => ActionContext | null
  ) {}

  install(plugin: Plugin): void {
    // `canvas:node-menu` is a Canvas-internal event, not in the typed API.
    const workspace = this.app.workspace as unknown as {
      on(name: "canvas:node-menu", cb: (menu: Menu, node: CanvasNodeLike) => void): EventRef;
    };
    plugin.registerEvent(
      workspace.on("canvas:node-menu", (menu: Menu, node: CanvasNodeLike) => {
        try {
          this.inject(menu, node);
        } catch (error) {
          console.error("[Volis] menu injection failed", error);
        }
      })
    );
  }

  private inject(menu: Menu, node: CanvasNodeLike): void {
    const data: CanvasNodeData =
      typeof node.getData === "function"
        ? (node.getData() ?? {})
        : (node as unknown as CanvasNodeData);
    const nodeId = data.id;
    if (!nodeId) return;

    const ctx = this.resolveContext(nodeId);
    if (!ctx) return;

    const actions = this.registry.forContext(ctx);
    if (actions.length === 0) return;

    menu.addSeparator();
    for (const action of actions) {
      menu.addItem((item) => {
        item
          .setTitle(action.label)
          .setIcon(action.icon ?? "dot")
          .onClick(() => {
            void action.run(ctx);
          });
      });
    }
  }
}
