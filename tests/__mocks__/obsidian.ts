/**
 * Mock implementation of official Obsidian API for Node/Vitest test environment.
 */

export interface RequestUrlParam {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: unknown;
  text: string;
}

export async function requestUrl(params: RequestUrlParam): Promise<RequestUrlResponse> {
  const method = params.method || "GET";
  const headers = new Headers(params.headers || {});

  let body: BodyInit | undefined = undefined;
  if (params.body && method !== "GET" && method !== "HEAD") {
    body = params.body;
  }

  const res = await fetch(params.url, {
    method,
    headers,
    body,
  });

  const arrayBuffer = await res.arrayBuffer();
  const text = new TextDecoder().decode(arrayBuffer);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    parsedJson = null;
  }

  const resHeaders: Record<string, string> = {};
  res.headers.forEach((val, key) => {
    resHeaders[key] = val;
  });

  const response: RequestUrlResponse = {
    status: res.status,
    headers: resHeaders,
    arrayBuffer,
    json: parsedJson,
    text,
  };

  if (params.throw !== false && (res.status < 200 || res.status >= 300)) {
    throw new Error(`Request failed with status ${res.status}`);
  }

  return response;
}

export class TFile {
  path = "";
  name = "";
  stat = { mtime: 0, ctime: 0, size: 0 };
}

export class TFolder {
  path = "";
  name = "";
}

export interface MockVault {
  getFiles: () => TFile[];
  read: (file: TFile) => Promise<string>;
  readBinary: (file: TFile) => Promise<ArrayBuffer>;
  getAbstractFileByPath: (path: string) => TFile | TFolder | null;
  create: (path: string, data: string) => Promise<TFile>;
  createBinary: (path: string, data: ArrayBuffer) => Promise<TFile>;
  modify: (file: TFile, data: string) => Promise<void>;
  modifyBinary: (file: TFile, data: ArrayBuffer) => Promise<void>;
  createFolder: (path: string) => Promise<TFolder>;
  adapter: {
    write: (path: string, data: string) => Promise<void>;
    writeBinary: (path: string, data: ArrayBuffer) => Promise<void>;
    read: (path: string) => Promise<string>;
    readBinary: (path: string) => Promise<ArrayBuffer>;
    exists: (path: string) => Promise<boolean>;
    mkdir: (path: string) => Promise<void>;
    remove: (path: string) => Promise<void>;
    rmdir: (path: string, recursive?: boolean) => Promise<void>;
    list: (path: string) => Promise<{ files: string[]; folders: string[] }>;
    stat?: (path: string) => Promise<{ mtime: number; ctime: number; size: number } | null>;
  };
  configDir?: string;
  delete: (file: TFile | TFolder) => Promise<void>;
}

export class MockLocalStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) || null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] || null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

if (typeof globalThis.localStorage === "undefined") {
  (globalThis as unknown as { localStorage: Storage }).localStorage = new MockLocalStorage();
}
if (typeof (globalThis as unknown as { window?: { localStorage: Storage } }).window === "undefined") {
  (globalThis as unknown as { window: { localStorage: Storage } }).window = { localStorage: globalThis.localStorage };
}

export class MockSecretStorage {
  private secrets: Map<string, string> = new Map();

  private validateId(id: string): boolean {
    return /^[a-z0-9-]+$/.test(id) && id.length <= 64;
  }

  async getSecret(key: string): Promise<string | null> {
    if (!this.validateId(key)) {
      throw new Error(`Invalid secret ID: "${key}". IDs must be lowercase alphanumeric with optional dashes and <= 64 characters.`);
    }
    return this.secrets.get(key) || null;
  }

  async setSecret(key: string, value: string | null): Promise<void> {
    if (!this.validateId(key)) {
      throw new Error(`Invalid secret ID: "${key}". IDs must be lowercase alphanumeric with optional dashes and <= 64 characters.`);
    }
    if (value === null || value === undefined) {
      this.secrets.delete(key);
    } else {
      this.secrets.set(key, value);
    }
  }

  async deleteSecret(key: string): Promise<void> {
    if (!this.validateId(key)) {
      throw new Error(`Invalid secret ID: "${key}". IDs must be lowercase alphanumeric with optional dashes and <= 64 characters.`);
    }
    this.secrets.delete(key);
  }

  async listSecrets(): Promise<string[]> {
    return Array.from(this.secrets.keys());
  }
}

export class App {
  secretStorage: MockSecretStorage = new MockSecretStorage();
  vault: MockVault;

  constructor() {
    const filesMap = new Map<string, { content: ArrayBuffer; mtime: number }>();

    this.vault = {
      getFiles: () => {
        const result: TFile[] = [];
        const cfg = (this.vault as unknown as { configDir?: string }).configDir || ".obsidian";
        for (const [p, data] of filesMap.entries()) {
          if (p.startsWith(cfg + "/") || p.startsWith(".obsidian/")) {
            continue;
          }
          const tf = new TFile();
          tf.path = p;
          tf.name = p.split("/").pop() || p;
          tf.stat = { mtime: data.mtime, ctime: data.mtime, size: data.content.byteLength };
          result.push(tf);
        }
        return result;
      },
      read: async (file: TFile) => {
        const entry = filesMap.get(file.path);
        if (!entry) throw new Error(`File not found: ${file.path}`);
        return new TextDecoder().decode(entry.content);
      },
      readBinary: async (file: TFile) => {
        const entry = filesMap.get(file.path);
        if (!entry) throw new Error(`File not found: ${file.path}`);
        return entry.content;
      },
      getAbstractFileByPath: (path: string) => {
        const entry = filesMap.get(path);
        if (entry) {
          const tf = new TFile();
          tf.path = path;
          tf.name = path.split("/").pop() || path;
          tf.stat = { mtime: entry.mtime, ctime: entry.mtime, size: entry.content.byteLength };
          return tf;
        }
        return null;
      },
      create: async (path: string, data: string) => {
        const encoded = new TextEncoder().encode(data);
        filesMap.set(path, { content: encoded.buffer as ArrayBuffer, mtime: Date.now() });
        const tf = new TFile();
        tf.path = path;
        tf.stat = { mtime: Date.now(), ctime: Date.now(), size: encoded.byteLength };
        return tf;
      },
      createBinary: async (path: string, data: ArrayBuffer) => {
        filesMap.set(path, { content: data, mtime: Date.now() });
        const tf = new TFile();
        tf.path = path;
        tf.stat = { mtime: Date.now(), ctime: Date.now(), size: data.byteLength };
        return tf;
      },
      modify: async (file: TFile, data: string) => {
        const encoded = new TextEncoder().encode(data);
        filesMap.set(file.path, { content: encoded.buffer as ArrayBuffer, mtime: Date.now() });
      },
      modifyBinary: async (file: TFile, data: ArrayBuffer) => {
        filesMap.set(file.path, { content: data, mtime: Date.now() });
      },
      createFolder: async (path: string) => {
        const tf = new TFolder();
        tf.path = path;
        return tf;
      },
      configDir: ".obsidian",
      delete: async (file: TFile | TFolder) => {
        filesMap.delete(file.path);
        for (const k of Array.from(filesMap.keys())) {
          if (k.startsWith(file.path + "/")) {
            filesMap.delete(k);
          }
        }
      },
      adapter: {
        write: async (path: string, data: string) => {
          const encoded = new TextEncoder().encode(data);
          const buf = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
          filesMap.set(path, { content: buf, mtime: Date.now() });
        },
        writeBinary: async (path: string, data: ArrayBuffer) => {
          filesMap.set(path, { content: data, mtime: Date.now() });
        },
        read: async (path: string) => {
          const entry = filesMap.get(path);
          if (!entry) throw new Error(`File not found: ${path}`);
          return new TextDecoder().decode(entry.content);
        },
        readBinary: async (path: string) => {
          const entry = filesMap.get(path);
          if (!entry) throw new Error(`File not found: ${path}`);
          return entry.content;
        },
        exists: async (path: string) => {
          if (filesMap.has(path)) return true;
          const prefix = path.endsWith("/") ? path : path + "/";
          for (const k of filesMap.keys()) {
            if (k.startsWith(prefix)) return true;
          }
          return false;
        },
        mkdir: async () => {},
        remove: async (path: string) => {
          filesMap.delete(path);
        },
        rmdir: async (path: string) => {
          filesMap.delete(path);
          for (const k of Array.from(filesMap.keys())) {
            if (k.startsWith(path + "/") || k === path) {
              filesMap.delete(k);
            }
          }
        },
        list: async (path: string) => {
          const files: string[] = [];
          const folders = new Set<string>();
          const prefix = path.endsWith("/") ? path : path + "/";
          for (const k of filesMap.keys()) {
            if (k.startsWith(prefix)) {
              const rel = k.substring(prefix.length);
              const parts = rel.split("/");
              if (parts.length === 1) {
                files.push(k);
              } else {
                folders.add(prefix + parts[0]);
              }
            }
          }
          return { files, folders: Array.from(folders) };
        },
        stat: async (path: string) => {
          const entry = filesMap.get(path);
          if (entry) {
            return { mtime: entry.mtime, ctime: entry.mtime, size: entry.content.byteLength };
          }
          return null;
        },
      },
    };
  }
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  description: string;
  author: string;
  isDesktopOnly?: boolean;
}

export interface CommandConfig {
  id: string;
  name: string;
  callback?: () => void;
}

export class Plugin {
  app: App;
  manifest: PluginManifest;
  constructor(app: App, manifest: PluginManifest) {
    this.app = app;
    this.manifest = manifest;
  }
  loadData = async (): Promise<unknown> => ({});
  saveData = async (_data: unknown): Promise<void> => {};
  addSettingTab = (_settingTab: PluginSettingTab): void => {};
  addRibbonIcon = (_icon: string, _title: string, _callback: () => void): HTMLElement => ({}) as HTMLElement;
  addCommand = (_command: CommandConfig): CommandConfig => _command;
}

export class PluginSettingTab {
  app: App;
  plugin: Plugin;
  containerEl: HTMLElement;
  constructor(app: App, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = {} as HTMLElement;
  }
  display(): void {}
  hide(): void {}
}

export class Setting {
  constructor(_el: HTMLElement) {}
  setName(_name: string): this { return this; }
  setDesc(_desc: string): this { return this; }
  addText(_cb: (text: unknown) => void): this { return this; }
  addTextArea(_cb: (textArea: unknown) => void): this { return this; }
  addButton(_cb: (button: unknown) => void): this { return this; }
}

export class MockElement {
  tag: string;
  classes: Set<string> = new Set();
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  textContent: string = "";
  children: MockElement[] = [];
  disabled: boolean = false;
  onclick?: (e?: unknown) => void | Promise<void>;

  constructor(tag = "div") {
    this.tag = tag;
  }

  addClass(cls: string): void {
    this.classes.add(cls);
  }

  removeClass(cls: string): void {
    this.classes.delete(cls);
  }

  hasClass(cls: string): boolean {
    return this.classes.has(cls);
  }

  empty(): void {
    this.children = [];
    this.textContent = "";
  }

  setText(text: string): void {
    this.textContent = text;
  }

  createEl(tag: string, options?: { text?: string; cls?: string; attr?: Record<string, string> }): MockElement {
    const el = new MockElement(tag);
    if (options?.text) el.setText(options.text);
    if (options?.cls) el.addClass(options.cls);
    if (options?.attr) Object.assign(el.attributes, options.attr);
    this.children.push(el);
    return el;
  }

  createDiv(options?: { text?: string; cls?: string; attr?: Record<string, string> }): MockElement {
    return this.createEl("div", options);
  }

  createSpan(options?: { text?: string; cls?: string; attr?: Record<string, string> }): MockElement {
    return this.createEl("span", options);
  }

  findAll(predicate: (el: MockElement) => boolean): MockElement[] {
    const results: MockElement[] = [];
    if (predicate(this)) {
      results.push(this);
    }
    for (const child of this.children) {
      results.push(...child.findAll(predicate));
    }
    return results;
  }
}

export class Modal {
  app: App;
  modalEl: MockElement = new MockElement("div");
  contentEl: MockElement = new MockElement("div");
  isOpen: boolean = false;

  constructor(app: App) {
    this.app = app;
  }

  open(): void | Promise<void> {
    this.isOpen = true;
    return this.onOpen();
  }

  close(): void {
    this.isOpen = false;
    this.onClose();
  }

  onOpen(): void | Promise<void> {}
  onClose(): void | Promise<void> {}
}

export class Notice {
  constructor(_msg: string, _timeout?: number) {}
  hide(): void {}
}

export function setIcon(_el: HTMLElement, _iconId: string): void {}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}
