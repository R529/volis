import { App, Modal } from "obsidian";
import { BOARD_SHORTCUTS } from "../board/shortcuts";

/**
 * Read-only reference for gestures handled inside the board itself. It is not
 * a settings panel: nothing here is editable, and command-style shortcuts are
 * explicitly left to Obsidian's own hotkey settings.
 */
export class ShortcutHelpModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("volis-help-modal");

    this.titleEl.setText("白板快捷键");

    const host = this.contentEl;
    host.empty();
    host.addClass("volis-help-content");

    host.createEl("p", {
      cls: "volis-help-scope",
      text: "仅适用于 Volis 白板内的操作。",
    });

    const scroll = host.createDiv({ cls: "volis-help-scroll" });
    for (const group of BOARD_SHORTCUTS) {
      const section = scroll.createDiv({ cls: "volis-help-group" });
      section.createDiv({ cls: "volis-help-group-title", text: group.title });

      for (const item of group.items) {
        const row = section.createDiv({ cls: "volis-help-row" });
        row.createSpan({ cls: "volis-help-label", text: item.label });
        const keys = row.createDiv({ cls: "volis-help-keys" });
        for (const key of item.keys) {
          keys.createSpan({ cls: "volis-help-key", text: key });
        }
      }
    }

    host.createDiv({
      cls: "volis-help-foot",
      text: "命令类操作（如白板体检、AI 面板）的快捷键，可在 设置 → 快捷键 → Volis 中修改。",
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
