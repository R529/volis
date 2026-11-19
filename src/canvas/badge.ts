import { CardMeta } from "../types";
import { VolisSettings } from "../settings";
import { NodeIndex } from "./nodeIndex";
import { CanvasViewLike, collectNodes } from "./canvasTypes";

const BADGE_CLASS = "volis-badge";

export function applyBadges(
  canvasView: CanvasViewLike,
  index: NodeIndex,
  settings: VolisSettings
): void {
  const canvas = canvasView.canvas;
  if (!canvas?.nodes) return;

  const container = canvasView.containerEl;

  for (const node of collectNodes(canvas.nodes)) {
    const nodeId = node.id ?? node.getData?.()?.id;
    if (!nodeId) continue;

    const el =
      node.nodeEl ??
      container.querySelector<HTMLElement>(`.canvas-node[data-id="${nodeId}"]`);
    if (!el) continue;

    let badge = el.querySelector<HTMLElement>(`.${BADGE_CLASS}`);
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

export function clearBadges(canvasView: CanvasViewLike): void {
  const canvas = canvasView.canvas;
  if (!canvas?.nodes) return;

  for (const node of collectNodes(canvas.nodes)) {
    const badge = node.nodeEl?.querySelector(`.${BADGE_CLASS}`);
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
