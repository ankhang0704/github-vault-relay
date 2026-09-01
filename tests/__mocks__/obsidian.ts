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
  };
}

export class MockSecretStorage {
  private secrets: Map<string, string> = new Map();

  async getSecret(key: string): Promise<string | null> {
    return this.secrets.get(key) || null;
  }

  async setSecret(key: string, value: string): Promise<void> {
    this.secrets.set(key, value);
  }

  async deleteSecret(key: string): Promise<void> {
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
        for (const [p, data] of filesMap.entries()) {
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
      adapter: {
        write: async (path: string, data: string) => {
          const encoded = new TextEncoder().encode(data);
          filesMap.set(path, { content: encoded.buffer as ArrayBuffer, mtime: Date.now() });
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
          return filesMap.has(path);
        },
        mkdir: async () => {},
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

export class Modal {
  app: App;
  modalEl: { addClass: (cls: string) => void; style: Record<string, string> } = {
    addClass: () => {},
    style: {},
  };
  contentEl: { empty: () => void; createDiv: () => HTMLElement; createEl: () => HTMLElement } = {
    empty: () => {},
    createDiv: () => ({}) as HTMLElement,
    createEl: () => ({}) as HTMLElement,
  };
  constructor(app: App) {
    this.app = app;
  }
  open(): void {}
  close(): void {}
  onOpen(): void {}
  onClose(): void {}
}

export class Notice {
  constructor(_msg: string, _timeout?: number) {}
  hide(): void {}
}

export function setIcon(_el: HTMLElement, _iconId: string): void {}
