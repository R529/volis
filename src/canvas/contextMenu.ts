import { App, Menu, Plugin } from "obsidian";
import { ActionContext, ActionRegistry } from "./actions";

export class ContextMenuInjector {
  constructor(
    private app: App,
    private registry: ActionRegistry,
    private resolveContext: (nodeId: string) => ActionContext | null
  ) {}

  install(plugin: Plugin): void {
    const workspace: any = this.app.workspace;
    plugin.registerEvent(
      workspace.on("canvas:node-menu", (menu: Menu, node: any) => {
        try {
          this.inject(menu, node);
        } catch (error) {
          console.error("[Volis] menu injection failed", error);
        }
      })
    );
  }

  private inject(menu: Menu, node: any): void {
    const data = typeof node?.getData === "function" ? node.getData() : node;
    const nodeId: string | undefined = data?.id;
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
