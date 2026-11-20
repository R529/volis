/** Board wall styles.
 *
 *  Rules of this file: colours come only from the active theme (no hardcoded
 *  values), and nothing depends on `--interactive-accent`, which some themes
 *  leave undefined. The primary button inverts the text colour instead, so it
 *  reads as "solid" in both light and dark without borrowing a theme accent. */

export const WORKBENCH_CSS = `
/* This view only: Obsidian's own header row is trimmed to a thin bar, and the
   wall is pinned to the leaf so its frame sits right under the tabs and right
   above the bottom of the pane. */
.workspace-leaf:has(.wb-root),
.workspace-leaf:has(.wb-root) .workspace-leaf-content { position: relative; }
.workspace-leaf:has(.wb-root) .view-header {
  box-sizing: border-box;
  height: 24px;
  min-height: 24px;
  padding: 0 8px;
}
.workspace-leaf:has(.wb-root) .view-header .view-header-nav-buttons,
.workspace-leaf:has(.wb-root) .view-header .view-actions { height: 24px; }

.wb-root {
  --vw-line: var(--background-modifier-border, var(--background-modifier-hover));
  --vw-soft: var(--background-modifier-hover);
  --vw-tint: var(--background-secondary-alt, var(--background-secondary));
  --vw-shadow: 0 14px 30px -20px rgba(0, 0, 0, .6);
  --vw-card-w: 208px;

  position: absolute;
  top: 24px;
  right: 0;
  bottom: 0;
  left: 0;
  box-sizing: border-box;
  padding: 4px 8px;
  overflow: hidden;
  background: var(--background-secondary);
  color: var(--text-normal);
  font-family: inherit;
  -webkit-font-smoothing: antialiased;
}

/* ---------- Frame: the whole page sits on one bordered layer ---------- */
.wb-root .vw-frame {
  position: relative;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  height: 100%;
  border: 1px solid var(--vw-line);
  border-radius: 12px;
  background: var(--background-primary);
  box-shadow: 0 1px 3px rgba(0, 0, 0, .05);
}
.wb-root .vw-toolbar {
  position: relative;
  z-index: 2;
  flex: 0 0 auto;
  margin: 10px 20px 12px;
  padding: 9px 12px;
  border: 1px solid var(--vw-line);
  border-radius: 10px;
  background: var(--background-primary);
  box-shadow: 0 3px 10px -6px rgba(0, 0, 0, .32);
}
.wb-root .vw-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 24px 14px;
}

/* ---------- Header ---------- */
.wb-root .vw-head {
  display: flex;
  align-items: flex-end;
  gap: 18px;
  padding: 0;
  flex-wrap: wrap;
}
.wb-root .vw-intro { min-width: 0; }
.wb-root .vw-title { display: flex; align-items: baseline; gap: 10px; }
.wb-root .vw-title h1 {
  margin: 0;
  font-size: 26px;
  line-height: 1.12;
  font-weight: 650;
  letter-spacing: -.032em;
  color: var(--text-normal);
}
.wb-root .vw-count {
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
  background: var(--vw-soft);
  border-radius: 20px;
  padding: 3px 9px;
  transform: translateY(-2px);
}

/* ---------- Toolbar ---------- */
.wb-root .vw-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.wb-root .vw-ico { display: inline-flex; align-items: center; }
.wb-root .vw-ico svg { width: 14px; height: 14px; }

/* ---------- Search ---------- */
.wb-root .vw-search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 9px;
  border: 1px solid var(--vw-line);
  border-radius: 8px;
  background: var(--background-secondary);
  color: var(--text-faint);
  transition: border-color .14s ease;
}
.wb-root .vw-search:focus-within {
  border-color: var(--background-modifier-border-hover, var(--text-faint));
}
.wb-root .vw-search-input {
  all: unset;
  display: block;
  width: 116px;
  padding: 0;
  font: inherit;
  font-size: 12px;
  line-height: 1.3;
  color: var(--text-normal);
  background: transparent;
  cursor: text;
}
.wb-root .vw-search-input::placeholder { color: var(--text-faint); opacity: 1; }
.wb-root .vw-search-input::-webkit-search-cancel-button { -webkit-appearance: none; }

.wb-root .vw-sort {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 8px 0 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  font: inherit;
  font-size: 12px;
  color: var(--text-muted);
  background: transparent;
  cursor: pointer;
  transition: color .14s ease, background .14s ease, border-color .14s ease;
}
.wb-root .vw-sort:hover {
  color: var(--text-normal);
  background: var(--vw-soft);
  border-color: var(--vw-line);
}
.wb-root .vw-caret { opacity: .6; margin-left: -1px; }
.wb-root .vw-caret svg { width: 12px; height: 12px; }

.wb-root .vw-primary {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 15px;
  border: 1px solid var(--vw-line);
  border-radius: 9px;
  background: var(--background-modifier-hover);
  color: var(--text-normal);
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: -.005em;
  cursor: pointer;
  transition: opacity .14s ease, transform .14s ease;
}
.wb-root .vw-ghost {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--vw-line);
  border-radius: 8px;
  background: transparent;
  color: var(--text-normal);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.wb-root .vw-ghost:hover { background: var(--vw-soft); }
.wb-root .vw-ghost:disabled, .wb-root .vw-primary:disabled { opacity: .45; cursor: default; }
.wb-root .vw-multi-count {
  margin-right: auto;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-normal);
}
.wb-root .vw-danger {
  background: var(--color-red, var(--text-normal));
  color: var(--background-primary);
  border-color: transparent;
}
.wb-root .vw-more { padding: 0 8px; }
.wb-root .vw-more .vw-ico svg { width: 16px; height: 16px; }
.wb-root .vw-primary:hover {
  background: var(--background-modifier-border-hover, var(--vw-soft));
}
.wb-root .vw-primary:active { transform: scale(.985); }
.wb-root .vw-primary.is-large {
  height: 36px;
  padding: 0 18px;
  font-size: 13px;
  margin-top: 20px;
}

/* ---------- Grid: fixed card width, identical in every pane layout -------- */
.wb-root .vw-grid {
  display: grid;
  /* A fixed track, not a flexible one: the card must be the same size whether
     the pane is 2-column or 3-column. Cards always start at the left edge,
     like the first tile in a file browser. */
  grid-template-columns: repeat(auto-fill, min(var(--vw-card-w), 100%));
  gap: 14px;
  align-content: start;
  justify-content: start;
}

.wb-root .vw-card {
  position: relative;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--vw-line);
  border-radius: 11px;
  overflow: hidden;
  background: var(--background-primary);
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .06);
  animation: vw-rise .3s cubic-bezier(.22, .61, .36, 1) both;
  transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease;
}
.wb-root .vw-card.is-selected {
  border-color: var(--color-blue, var(--text-muted));
  box-shadow: 0 0 0 2px var(--color-blue, var(--text-muted)), var(--vw-shadow);
}
.wb-root .vw-card-del {
  position: absolute;
  top: 7px;
  right: 7px;
  z-index: 3;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--vw-line);
  border-radius: 7px;
  background: var(--background-primary);
  color: var(--text-muted);
  opacity: 0;
  cursor: pointer;
  transition: opacity .15s ease, color .15s ease, border-color .15s ease;
}
.wb-root .vw-card:hover .vw-card-del,
.wb-root .vw-card-del:focus { opacity: 1; }
.wb-root .vw-card-del:hover {
  color: var(--color-red, var(--text-normal));
  border-color: var(--color-red, var(--vw-line));
}
.wb-root .vw-card-del svg { width: 14px; height: 14px; }
.wb-root .vw-check {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 3;
  display: none;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--color-blue, var(--text-muted));
  color: var(--background-primary);
}
.wb-root .vw-card.is-selected .vw-check { display: grid; }
.wb-root .vw-check svg { width: 12px; height: 12px; }
.wb-root .vw-card:nth-child(2) { animation-delay: .035s; }
.wb-root .vw-card:nth-child(3) { animation-delay: .07s; }
.wb-root .vw-card:nth-child(4) { animation-delay: .105s; }
.wb-root .vw-card:nth-child(5) { animation-delay: .14s; }
.wb-root .vw-card:nth-child(n+6) { animation-delay: .18s; }
.wb-root .vw-card:hover {
  transform: translateY(-2px);
  border-color: var(--background-modifier-border-hover, var(--text-faint));
  box-shadow: var(--vw-shadow);
}
/* Hover must not mask the selection ring: same specificity as :hover, but
   declared later, so a selected card keeps its blue outline while pointed at. */
.wb-root .vw-card.is-selected:hover {
  border-color: var(--color-blue, var(--text-muted));
  box-shadow: 0 0 0 2px var(--color-blue, var(--text-muted)), var(--vw-shadow);
}
@keyframes vw-rise {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}

/* ---------- Cover: a miniature of the board ---------- */
.wb-root .vw-cover {
  position: relative;
  aspect-ratio: 16 / 10;
  overflow: hidden;
  border-bottom: 1px solid var(--vw-line);
  background-color: var(--vw-tint);
  background-image: radial-gradient(var(--vw-line) 1px, transparent 1px);
  background-size: 14px 14px;
  background-position: 6px 6px;
}
.wb-root .vw-cover.is-blank {
  display: grid;
  place-items: center;
}
.wb-root .vw-cover-ghost {
  display: inline-flex;
  color: var(--text-faint);
  opacity: .55;
}
.wb-root .vw-cover-ghost svg { width: 30px; height: 30px; }
/* An empty board still shows a canvas: a dashed artboard inside the cover. */
.wb-root .vw-cover.is-blank::after {
  content: "";
  position: absolute;
  inset: 15%;
  border: 1px dashed var(--vw-line);
  border-radius: 5px;
  opacity: .8;
  pointer-events: none;
}

.wb-root .vw-cover-lines {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.wb-root .vw-cover-lines line {
  stroke: var(--text-faint);
  stroke-width: 1;
  opacity: .45;
  vector-effect: non-scaling-stroke;
}

.wb-root .vw-chip {
  position: absolute;
  display: block;
  border-radius: 3px;
  overflow: hidden;
  background: var(--background-primary);
  box-shadow: inset 0 0 0 1px var(--vw-line);
  transition: box-shadow .18s ease;
}
.wb-root .vw-chip::before {
  content: "";
  position: absolute;
  inset: 0;
  background: var(--tn, var(--text-muted));
  opacity: .18;
}
.wb-root .vw-chip[data-kind="text"]::before { opacity: .26; }
.wb-root .vw-chip[data-kind="group"]::before { opacity: .1; }
.wb-root .vw-card:hover .vw-chip { box-shadow: inset 0 0 0 1px var(--text-faint); }
.wb-root .vw-chip-text {
  position: relative;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  overflow: hidden;
  padding: 2px 3px;
  font-size: 7px;
  line-height: 1.4;
  letter-spacing: 0;
  color: var(--text-normal);
  opacity: .92;
  word-break: break-word;
}
.wb-root .vw-chip[data-tone="orange"] { --tn: var(--color-orange); }
.wb-root .vw-chip[data-tone="red"] { --tn: var(--color-red); }
.wb-root .vw-chip[data-tone="yellow"] { --tn: var(--color-yellow); }
.wb-root .vw-chip[data-tone="green"] { --tn: var(--color-green); }
.wb-root .vw-chip[data-tone="cyan"] { --tn: var(--color-cyan); }
.wb-root .vw-chip[data-tone="blue"] { --tn: var(--color-blue); }
.wb-root .vw-chip[data-tone="purple"] { --tn: var(--color-purple); }
.wb-root .vw-chip[data-tone="pink"] { --tn: var(--color-pink); }

/* ---------- Card body: title, date, properties ---------- */
.wb-root .vw-card-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 11px 13px 12px;
}
.wb-root .vw-card-head {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.wb-root .vw-card-icon {
  display: inline-flex;
  flex: 0 0 auto;
  color: var(--text-faint);
  transition: color .16s ease;
}
.wb-root .vw-card:hover .vw-card-icon { color: var(--text-muted); }
.wb-root .vw-card-icon svg { width: 14px; height: 14px; }
.wb-root .vw-card-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -.012em;
  color: var(--text-normal);
}
.wb-root .vw-card-date {
  font-size: 11.5px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.wb-root .vw-card-props {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-top: 2px;
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.wb-root .vw-prop { display: inline-flex; align-items: center; gap: 4px; }
.wb-root .vw-prop .vw-ico svg { width: 11px; height: 11px; }

/* ---------- Confirmation modal ---------- */
.volis-delete-modal .vw-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 22px;
}
.volis-delete-modal button { font: inherit; }
.volis-rename-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}

/* ---------- Empty ---------- */
.wb-root .vw-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 38px 24px 44px;
  animation: vw-rise .32s ease both;
}
.wb-root .vw-empty-art {
  display: grid;
  place-items: center;
  width: 74px;
  height: 74px;
  border-radius: 20px;
  color: var(--text-muted);
  background: var(--background-secondary);
  border: 1px solid var(--vw-line);
  box-shadow: var(--vw-shadow);
}
.wb-root .vw-empty-art svg { width: 32px; height: 32px; }
.wb-root .vw-empty-title {
  margin-top: 18px;
  font-size: 15.5px;
  font-weight: 600;
  letter-spacing: -.01em;
  color: var(--text-normal);
}
.wb-root .vw-empty-hint {
  margin: 7px 0 0;
  max-width: 320px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-muted);
}

/* ---------- Error ---------- */
.wb-root .vw-error {
  margin: 30px 0;
  padding: 18px 20px;
  border-radius: 12px;
  border: 1px solid var(--color-red, var(--vw-line));
  background: var(--background-secondary);
  color: var(--text-normal);
}
.wb-root .vw-error strong { display: block; font-size: 13.5px; margin-bottom: 6px; }
.wb-root .vw-error p {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-muted);
  word-break: break-word;
}

@media (max-width: 780px) {
  .wb-root { padding: 4px 6px; }
  .wb-root .vw-scroll { padding: 0 14px 12px; }
  .wb-root .vw-grid { gap: 12px; }
  .wb-root .vw-actions { margin-left: 0; }
}
`; // end WORKBENCH_CSS
