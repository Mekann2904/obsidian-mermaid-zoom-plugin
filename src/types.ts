import { Editor } from "obsidian";

// --- 設定インターフェース ---
export interface MermaidZoomPluginSettings {
  pngScale: number;
  geminiApiKey?: string;
  geminiModel: string;
  applyMode: "confirm" | "auto";
  requestTimeoutMs: number;
  preserveInitDirective: boolean;
}

export const DEFAULT_SETTINGS: MermaidZoomPluginSettings = {
  pngScale: 10,
  geminiApiKey: "",
  geminiModel: "gemini-2.5-flash-lite",
  applyMode: "confirm",
  requestTimeoutMs: 30000,
  preserveInitDirective: true,
};

// === Mermaid ブロック情報
export type MermaidBlock = {
  startOffset: number;
  endOffset: number;
  fenceOpen: string;
  fenceClose: string;
  info: string;
  code: string;
  index: number;
};

// ビルドオプション
export type BuildOpts = {
  mermaidVersion?: string;
  diagramHint?: string;
  enforceCodeOnly?: boolean;
  useSentinel?: boolean;
};

export type OffsetRangeReplacement = { start: number; end: number; text: string };

