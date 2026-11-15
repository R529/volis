/**
 * In-place editor: overlays the node itself so editing feels like the card
 * became an input field, instead of opening a separate dialog.
 */
export class InlineEditor {
  private root: HTMLElement;
  private hostEl: HTMLElement;
  private input: HTMLTextAreaElement;
  private closed = false;
  private focusGuardUntil = 0;
  private caretPlaced = false;

  constructor(
    nodeEl: HTMLElement,
    initial: string,
    private onCommit: (value: string) => Promise<void> | void,
    private onCancel: () => void,
    private clickY?: number,
    private onClosed?: () => void
  ) {
    this.root = document.createElement("div");
    this.root.className = "volis-inline";
    this.hostEl = nodeEl;

    this.input = document.createElement("textarea");
    this.input.className = "volis-inline-input";
    this.input.value = initial;
    this.input.spellcheck = false;

    this.root.appendChild(this.input);
    nodeEl.appendChild(this.root);
    nodeEl.classList.add("volis-editing");
    nodeEl.classList.add("is-selected");

    this.input.addEventListener("mousedown", (evt) => evt.stopPropagation());
    this.input.addEventListener("dblclick", (evt) => evt.stopPropagation());
    this.input.addEventListener("keydown", (evt: KeyboardEvent) => {
      if (evt.key === "Escape") {
        evt.preventDefault();
        this.cancel();
        return;
      }
      if ((evt.ctrlKey || evt.metaKey) && evt.key === "Enter") {
        evt.preventDefault();
        void this.commit();
      }
    });

    document.addEventListener("mousedown", this.handleOutside, true);
    this.input.addEventListener("blur", this.handleBlur);

    window.setTimeout(() => this.tryFocus(), 20);
    window.setTimeout(() => this.tryFocus(), 120);
  }

  /**
   * The canvas steals focus back right after the click that opened us, so
   * claim focus more than once and re-claim it if it bounces within the first
   * few frames.
   */
  private tryFocus(): void {
    if (this.closed) return;
    this.focusGuardUntil = Date.now() + 400;
    this.input.focus();
    if (!this.caretPlaced) {
      this.placeCaret();
      this.caretPlaced = true;
    }
  }

  private handleBlur = (): void => {
    if (this.closed) return;
    if (Date.now() > this.focusGuardUntil) return;
    window.setTimeout(() => {
      if (this.closed) return;
      if (document.activeElement === this.input) return;
      this.input.focus();
    }, 20);
  };

  private placeCaret(): void {
    const value = this.input.value;
    if (typeof this.clickY !== "number") {
      this.input.setSelectionRange(value.length, value.length);
      return;
    }

    try {
      const style = window.getComputedStyle(this.input);
      const lineHeight = parseFloat(style.lineHeight) || 20;
      const rect = this.input.getBoundingClientRect();
      const offset = this.clickY - rect.top + this.input.scrollTop;
      const lines = value.split("\n");
      const line = Math.max(0, Math.min(Math.floor(offset / lineHeight), lines.length - 1));

      let index = 0;
      for (let i = 0; i < line; i++) index += lines[i].length + 1;
      this.input.setSelectionRange(index, index);
    } catch (error) {
      this.input.setSelectionRange(value.length, value.length);
    }
  }

  private handleOutside = (evt: MouseEvent) => {
    const target = evt.target as Node | null;
    if (!target) return;
    if (this.root.contains(target)) return;
    void this.commit();
  };

  private async commit(): Promise<void> {
    if (this.closed) return;
    const value = this.input.value;
    this.closed = true;
    this.destroy();
    await this.onCommit(value);
  }

  private cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.destroy();
    this.onCancel();
  }

  destroy(): void {
    document.removeEventListener("mousedown", this.handleOutside, true);
    this.hostEl.classList.remove("volis-editing");
    this.root.remove();
    if (this.onClosed) this.onClosed();
  }

  get isOpen(): boolean {
    return !this.closed;
  }
}
