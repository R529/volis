import { CardMeta } from "../types";
import { VolisSettings } from "../settings";
import { NodeIndex, collectNodes } from "./nodeIndex";

const BADGE_CLASS = "volis-badge";

export function applyBadges(
  canvasView: any,
  index: NodeIndex,
  settings: VolisSettings
): void {
  const canvas = canvasView?.canvas;
  if (!canvas?.nodes) return;

  const container: HTMLElement | undefined = canvasView?.containerEl;

  for (const node of collectNodes(canvas.nodes)) {
    const nodeId: string | undefined =
      node?.id ?? (typeof node?.getData === "function" ? node.getData?.()?.id : undefined);
    if (!nodeId) continue;

    const el: HTMLElement | null =
      node?.nodeEl ??
      (container?.querySelector(`.canvas-node[data-id="${nodeId}"]`) as HTMLElement | null);
    if (!el) continue;

    let badge = el.querySelector(`.${BADGE_CLASS}`) as HTMLElement | null;
    const entry = index.get(nodeId);

    if (!settings.showBadge || !entry) {
      if (badge) badge.remove();
      continue;
    }

    if (!badge) {
      badge = document.createElement("div");
      badge.className = BADGE_CLASS;
      el.appendChild(badge);
    }

    const meta = entry.meta;
    if (!meta) {
      paint(badge, "…", false);
      continue;
    }

    if (meta.stale) {
      paint(badge, "卡片已删除", true);
      continue;
    }

    paint(badge, formatBadge(meta, settings.badgeFormat), false);
    badge.setAttribute("title", tooltip(meta));
  }
}

export function clearBadges(canvasView: any): void {
  const canvas = canvasView?.canvas;
  if (!canvas?.nodes) return;

  for (const node of collectNodes(canvas.nodes)) {
    const el: HTMLElement | undefined = node?.nodeEl;
    const badge = el?.querySelector(`.${BADGE_CLASS}`);
    if (badge) badge.remove();
  }
}

function formatBadge(meta: CardMeta, format: VolisSettings["badgeFormat"]): string {
  if (format === "full") {
    const parts: string[] = [];
    if (meta.tags.length > 0) parts.push(`#${meta.tags[0]}`);
    if (meta.date) parts.push(meta.date.slice(5));
    if (meta.time) parts.push(meta.time);
    return parts.join(" ");
  }
  if (meta.date) return meta.date.slice(5);
  return meta.time ?? "";
}

function tooltip(meta: CardMeta): string {
  const parts: string[] = [];
  if (meta.tags.length > 0) parts.push(meta.tags.map((t) => `#${t}`).join(" "));
  if (meta.date) parts.push(meta.date);
  if (meta.time) parts.push(meta.time);
  parts.push(meta.ref.file.replace(/\.md$/, ""));
  return parts.join(" · ");
}

/**
 * Only touch the DOM when something actually changed. Every write inside a
 * canvas node fires a mutation, so unconditional updates would keep waking up
 * the observer and repaint forever.
 */
function paint(badge: HTMLElement, text: string, stale: boolean): void {
  if (badge.textContent !== text) badge.setText(text);
  const currentlyStale = badge.hasClass("is-stale");
  if (stale !== currentlyStale) {
    if (stale) badge.addClass("is-stale");
    else badge.removeClass("is-stale");
  }
}
