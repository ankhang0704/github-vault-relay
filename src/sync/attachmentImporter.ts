/**
 * Mobile-Friendly Attachment Importer for Vault Relay (C4)
 *
 * Imports images (PNG/JPG), PDFs, and binary assets into the Obsidian vault
 * using standard browser File APIs and Obsidian's Vault.createBinary().
 *
 * 100% free of Node.js filesystem APIs for seamless iPhone/mobile compatibility.
 * Features automatic collision avoidance (e.g. "image (1).png") without silent overwrite.
 */

import { App, normalizePath } from "obsidian";
import { MAX_SAFE_FILE_SIZE_BYTES } from "./fileSizePolicy";

export interface AttachmentImportResult {
  success: boolean;
  fileName: string;
  vaultPath: string;
  size: number;
  error?: string;
}

export class AttachmentImporter {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  /**
   * Resolves the target folder path based on Obsidian attachment folder preferences.
   */
  public getAttachmentFolderPath(): string {
    try {
      const config = (this.app.vault as unknown as { getConfig?: (k: string) => unknown }).getConfig?.("attachmentFolderPath");
      if (typeof config === "string" && config.trim() && config !== "./") {
        return normalizePath(config.trim());
      }
    } catch {
      // Fallback
    }
    return "";
  }

  /**
   * Generates a collision-safe vault file path.
   * If "photo.png" exists, produces "photo (1).png", etc.
   */
  public generateUniqueVaultPath(folder: string, originalFileName: string): string {
    const cleanName = originalFileName.replace(/[\\/]/g, "_");
    const lastDot = cleanName.lastIndexOf(".");
    const base = lastDot !== -1 ? cleanName.substring(0, lastDot) : cleanName;
    const ext = lastDot !== -1 ? cleanName.substring(lastDot) : "";

    let candidate = folder ? normalizePath(`${folder}/${cleanName}`) : cleanName;
    let counter = 1;

    while (this.app.vault.getAbstractFileByPath(candidate)) {
      const numberedName = `${base} (${counter})${ext}`;
      candidate = folder ? normalizePath(`${folder}/${numberedName}`) : numberedName;
      counter++;
    }

    return candidate;
  }

  /**
   * Imports a browser File or Blob object into the Obsidian vault.
   */
  public async importFile(file: File): Promise<AttachmentImportResult> {
    try {
      if (file.size > MAX_SAFE_FILE_SIZE_BYTES) {
        return {
          success: false,
          fileName: file.name,
          vaultPath: "",
          size: file.size,
          error: `File exceeds the 25 MiB mobile safety ceiling (${(file.size / (1024 * 1024)).toFixed(1)} MiB).`,
        };
      }

      const buffer = await file.arrayBuffer();
      const folder = this.getAttachmentFolderPath();

      // Ensure target folder exists
      if (folder && !(await this.app.vault.adapter.exists(folder))) {
        await this.app.vault.adapter.mkdir(folder);
      }

      const targetPath = this.generateUniqueVaultPath(folder, file.name);
      await this.app.vault.createBinary(targetPath, buffer);

      return {
        success: true,
        fileName: file.name,
        vaultPath: targetPath,
        size: file.size,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        fileName: file.name,
        vaultPath: "",
        size: file.size,
        error: msg,
      };
    }
  }

  /**
   * Opens the browser file selector modal and returns imported file results.
   */
  public promptFileSelection(): Promise<AttachmentImportResult[]> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.style.display = "none";

      input.onchange = async () => {
        const files = input.files;
        if (!files || files.length === 0) {
          resolve([]);
          input.remove();
          return;
        }

        const results: AttachmentImportResult[] = [];
        for (let i = 0; i < files.length; i++) {
          const res = await this.importFile(files[i]);
          results.push(res);
        }

        input.remove();
        resolve(results);
      };

      document.body.appendChild(input);
      input.click();
    });
  }
}
