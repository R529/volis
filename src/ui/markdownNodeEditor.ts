import { App, TFile } from "obsidian";

/**
 * Editor for a markdown file node: the title is the file name, the body is the
 * file content. Both are editable in place, and renaming goes through the
 * file manager so links elsewhere keep working.
 */
export class MarkdownNodeEditor {
  private root: HTMLElement;
  private titleInput: HTMLInputElement;
  private bodyInput: HTMLTextAreaElement;
  private closed = false;

  constructor(
    private app: App,
    private nodeEl: HTMLElement,
    private file: TFile,
    initialBody: string,
    private onCommit: (file: TFile, body: string) => Promise<void> | void,
    private onCancel: () => void,
    private onClosed?: () => void
  ) {
    this.root = document.createElement("div");
    this.root.className = "volis-inline volis-md-editor";

    this.titleInput = document.createElement("input");
    this.titleInput.className = "volis-md-title inline-title";
    this.titleInput.type = "text";
    this.titleInput.value = file.basename;
    this.titleInput.spellcheck = false;

    this.bodyInput = document.createElement("textarea");
    this.bodyInput.className = "volis-inline-input volis-md-body";
    this.bodyInput.value = initialBody;
    this.bodyInput.spellcheck = false;

    this.root.appendChild(this.titleInput);
    this.root.appendChild(this.bodyInput);
    nodeEl.appendChild(this.root);
    nodeEl.classList.add("volis-editing");
    nodeEl.classList.add("is-selected");

    this.root.addEventListener("pointerdown", (evt) => evt.stopPropagation());
    this.root.addEventListener("dblclick", (evt) => evt.stopPropagation());

    this.root.addEventListener("keydown", (evt: KeyboardEvent) => {
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

    window.setTimeout(() => {
      if (this.closed) return;
      this.bodyInput.focus();
      const end = this.bodyInput.value.length;
      this.bodyInput.setSelectionRange(end, end);
    }, 40);
  }

  private handleOutside = (evt: MouseEvent) => {
    const target = evt.target as Node | null;
    if (!target) return;
    if (this.root.contains(target)) return;
    void this.commit();
  };

  private async commit(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const nextTitle = this.titleInput.value.trim();
    const nextBody = this.bodyInput.value;
    this.destroy();

    let target = this.file;

    if (nextTitle && nextTitle !== this.file.basename) {
      const folder = this.file.parent?.path ?? "";
      const nextPath = `${folder && folder !== "/" ? `${folder}/` : ""}${nextTitle}.md`;
      try {
        await this.app.fileManager.renameFile(this.file, nextPath);
        const renamed = this.app.vault.getAbstractFileByPath(nextPath);
        if (renamed instanceof TFile) target = renamed;
      } catch (error) {
        // rename failed (duplicate name, invalid chars) -> keep the old file
      }
    }

    await this.onCommit(target, nextBody);
  }

  private cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.destroy();
    this.onCancel();
  }

  private destroy(): void {
    document.removeEventListener("mousedown", this.handleOutside, true);
    this.nodeEl.classList.remove("volis-editing");
    this.root.remove();
    if (this.onClosed) this.onClosed();
  }
}
