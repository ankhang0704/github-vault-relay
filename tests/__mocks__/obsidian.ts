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

export interface MockVault {
  getFiles: () => TFile[];
  read: (file: TFile) => Promise<string>;
  readBinary: (file: TFile) => Promise<ArrayBuffer>;
  getAbstractFileByPath: (path: string) => TFile | null;
}

export class App {
  vault: MockVault = {
    getFiles: () => [],
    read: async () => "",
    readBinary: async () => new ArrayBuffer(0),
    getAbstractFileByPath: () => null,
  };
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

export class TFile {
  path = "";
  name = "";
  stat = { mtime: 0, ctime: 0, size: 0 };
}
