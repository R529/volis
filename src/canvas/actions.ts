import { App } from "obsidian";
import { NodeEntry } from "./nodeIndex";

export interface ActionContext {
  app: App;
  entry: NodeEntry;
  canvasView: any;
  nodeId: string;
}

export type ActionGroup = "card" | "ai" | "diagnostic";

export interface VolisAction {
  id: string;
  label: string;
  group: ActionGroup;
  icon?: string;
  available?: (ctx: ActionContext) => boolean;
  run: (ctx: ActionContext) => Promise<void> | void;
}

export class ActionRegistry {
  private actions: VolisAction[] = [];

  register(action: VolisAction): void {
    this.actions.push(action);
  }

  all(): VolisAction[] {
    return this.actions.slice();
  }

  forContext(ctx: ActionContext): VolisAction[] {
    return this.actions.filter((action) => {
      try {
        return !action.available || action.available(ctx);
      } catch (error) {
        return false;
      }
    });
  }

  byGroup(group: ActionGroup): VolisAction[] {
    return this.actions.filter((action) => action.group === group);
  }
}
