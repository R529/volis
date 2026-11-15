import { App, FuzzySuggestModal, TFile } from "obsidian";
import { listBoards } from "./boardStore";

export class BoardPickerModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private onPick: (file: TFile) => void) {
    super(app);
    this.setPlaceholder("选择要打开的白板");
  }

  getItems(): TFile[] {
    return listBoards(this.app);
  }

  getItemText(file: TFile): string {
    return file.basename;
  }

  onChooseItem(file: TFile): void {
    this.onPick(file);
  }
}
