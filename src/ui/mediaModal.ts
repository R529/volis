import { App, Modal, TFile } from "obsidian";

const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];
const VIDEO_EXT = ["mp4", "webm", "mov", "mkv"];
const AUDIO_EXT = ["mp3", "wav", "m4a", "ogg"];

export class MediaModal extends Modal {
  constructor(app: App, private file: TFile) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("volis-media-modal");
    this.titleEl.setText(this.file.basename);

    const src = this.app.vault.getResourcePath(this.file);
    const ext = this.file.extension.toLowerCase();

    if (IMAGE_EXT.includes(ext)) {
      const img = this.contentEl.createEl("img", { cls: "volis-media-image" });
      img.src = src;
      return;
    }

    if (VIDEO_EXT.includes(ext)) {
      const video = this.contentEl.createEl("video", { cls: "volis-media-video" });
      video.src = src;
      video.controls = true;
      video.autoplay = true;
      return;
    }

    if (AUDIO_EXT.includes(ext)) {
      const audio = this.contentEl.createEl("audio", { cls: "volis-media-audio" });
      audio.src = src;
      audio.controls = true;
      audio.autoplay = true;
      return;
    }

    if (ext === "pdf") {
      const embed = this.contentEl.createEl("embed", { cls: "volis-media-pdf" });
      embed.setAttribute("src", src);
      embed.setAttribute("type", "application/pdf");
      return;
    }

    this.contentEl.createEl("p", { text: `无法预览 .${ext} 文件` });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
