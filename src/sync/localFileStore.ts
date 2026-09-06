import { App, TFile } from "obsidian";
import { isPathExcluded, normalizePath } from "./pathFilter";
import { validatePathSafety } from "./pathSafety";

export interface LocalFileDescriptor {
  path: string;
  size: number;
  mtime: number;
}

/**
 * Obsidian's Vault index intentionally hides dot-prefixed folders. Keep those
 * paths on DataAdapter while retaining the normal Vault API for visible files.
 */
export function usesAdapter(path: string): boolean {
  return normalizePath(path).split("/").some((segment) => segment.startsWith("."));
}

export class LocalFileStore {
  private readonly app: App;
  private readonly exclusions: string[];

  constructor(app: App, exclusions: string[]) {
    this.app = app;
    this.exclusions = exclusions;
  }

  public async listFiles(): Promise<LocalFileDescriptor[]> {
    const files = new Map<string, LocalFileDescriptor>();

    for (const file of this.app.vault.getFiles()) {
      const path = normalizePath(file.path);
      if (!path || usesAdapter(path) || isPathExcluded(path, this.exclusions)) continue;
      files.set(path, { path, size: file.stat.size, mtime: file.stat.mtime });
    }

    await this.listAdapterFiles("", files);
    return Array.from(files.values());
  }

  public async exists(path: string): Promise<boolean> {
    const safePath = this.assertSafePath(path);
    return usesAdapter(safePath)
      ? this.app.vault.adapter.exists(safePath)
      : this.app.vault.getAbstractFileByPath(safePath) !== null;
  }

  public async readBinary(path: string): Promise<ArrayBuffer> {
    const safePath = this.assertSafePath(path);
    if (usesAdapter(safePath)) return this.app.vault.adapter.readBinary(safePath);

    const file = this.app.vault.getAbstractFileByPath(safePath);
    if (!(file instanceof TFile)) throw new Error(`Local file is missing: ${safePath}`);
    return this.app.vault.readBinary(file);
  }

  public async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const safePath = this.assertSafePath(path);
    await this.ensureParentFolderExists(safePath);

    if (usesAdapter(safePath)) {
      await this.app.vault.adapter.writeBinary(safePath, data);
      return;
    }

    const existing = this.app.vault.getAbstractFileByPath(safePath);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, data);
    } else if (!existing) {
      await this.app.vault.createBinary(safePath, data);
    } else {
      throw new Error(`Local path is a directory: ${safePath}`);
    }
  }

  public async move(path: string, newPath: string): Promise<void> {
    const safePath = this.assertSafePath(path);
    const safeNewPath = this.assertSafePath(newPath);
    await this.ensureParentFolderExists(safeNewPath);

    if (usesAdapter(safePath) || usesAdapter(safeNewPath)) {
      await this.app.vault.adapter.rename(safePath, safeNewPath);
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(safePath);
    if (!file) throw new Error(`Local file is missing: ${safePath}`);
    await this.app.fileManager.renameFile(file, safeNewPath);
  }

  private assertSafePath(path: string): string {
    const result = validatePathSafety(path, this.exclusions);
    if (!result.valid) throw new Error(`Unsafe local path '${path}': ${result.reason}`);
    return result.normalizedPath;
  }

  public async ensureParentFolderExists(filePath: string): Promise<void> {
    const lastSlash = filePath.lastIndexOf("/");
    if (lastSlash === -1) return;

    let currentPath = "";
    for (const segment of filePath.slice(0, lastSlash).split("/")) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      if (await this.exists(currentPath)) continue;
      if (usesAdapter(currentPath)) {
        await this.app.vault.adapter.mkdir(currentPath);
      } else {
        await this.app.vault.createFolder(currentPath);
      }
    }
  }

  private async listAdapterFiles(
    folderPath: string,
    files: Map<string, LocalFileDescriptor>
  ): Promise<void> {
    const listing = await this.app.vault.adapter.list(folderPath);

    for (const rawFilePath of listing.files) {
      const path = normalizePath(rawFilePath);
      if (!path || !usesAdapter(path) || isPathExcluded(path, this.exclusions)) continue;
      const safePath = validatePathSafety(path, this.exclusions);
      if (!safePath.valid) continue;
      const stat = await this.app.vault.adapter.stat(safePath.normalizedPath);
      if (stat) {
        files.set(safePath.normalizedPath, {
          path: safePath.normalizedPath,
          size: stat.size,
          mtime: stat.mtime,
        });
      }
    }

    for (const rawFolderPath of listing.folders) {
      const path = normalizePath(rawFolderPath);
      if (!path || isPathExcluded(path, this.exclusions)) continue;
      const safePath = validatePathSafety(path, this.exclusions);
      if (safePath.valid) await this.listAdapterFiles(safePath.normalizedPath, files);
    }
  }
}
