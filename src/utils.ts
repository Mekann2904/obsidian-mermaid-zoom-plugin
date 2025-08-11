// 汎用ユーティリティとMermaid関連ユーティリティ

// === 汎用ユーティリティ ===
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

// コードフェンスを除去する関数
export function stripCodeFences(text: string): string {
  return text.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
}

// オフセット→位置のフォールバック
export function offsetToPosFallback(text: string, offset: number): { line: number; ch: number } {
  const lines = text.slice(0, offset).split('\n');
  return { line: lines.length - 1, ch: lines[lines.length - 1]?.length || 0 };
}

// AbortController と併用するタイムアウト
export function withTimeout<T>(promise: Promise<T>, ms: number, controller?: AbortController): Promise<T> {
  if (ms <= 0) return promise;
  let to: number;
  const timeout = new Promise<T>((_, rej) => {
    to = window.setTimeout(() => {
      try { controller?.abort(); } catch {}
      rej(new Error("リクエストがタイムアウトしました。"));
    }, ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(to!)), timeout]);
}

export function stableJson(obj: any) {
  try { return JSON.stringify(obj); } catch { return String(obj); }
}

// === Mermaid 可用性・バリデーション ===
export function hasMermaid(): boolean {
  const m: any = (window as any).mermaid;
  return !!m && (!!m.parse || !!m.mermaidAPI?.parse || !!m.render);
}

// Mermaidの「軽量プリフィックス修正」：<br> をノード内ラベルの改行に置換
export function preNormalizeMermaid(code: string): string {
  const shapeOpen = `\\[|\\(|\\{`;
  const shapeClose = `\\]|\\)|\\}`;
  const re = new RegExp(
    `([A-Za-z0-9_\\-]+)\\s*(${shapeOpen}{1,2})\\s*([\\s\\S]*?)\\s*(${shapeClose}{1,2})`,
    "g"
  );
  return code.replace(re, (match, id, open, label, close) => {
    if (!/<br\s*\/?\s*>/i.test(label)) return match;
    const replaced = label.replace(/<br\s*\/?\s*>/gi, "\\n");
    const trimmed = replaced.trim();
    const wrapped = /^".*"$/.test(trimmed) ? trimmed : `"${trimmed}"`;
    return `${id}${open}${wrapped}${close}`;
  });
}

// ダイアグラム種別推定
export function inferDiagramType(code: string): string | null {
  const t = code.trim();
  if (/^sequenceDiagram\b/i.test(t)) return "sequenceDiagram";
  if (/^classDiagram\b/i.test(t)) return "classDiagram";
  if (/^erDiagram\b/i.test(t)) return "erDiagram";
  if (/^stateDiagram(?:-v2)?\b/i.test(t)) return "stateDiagram";
  if (/^gantt\b/i.test(t)) return "gantt";
  if (/^journey\b/i.test(t)) return "journey";
  if (/^pie\b/i.test(t)) return "pie";
  if (/^mindmap\b/i.test(t)) return "mindmap";
  if (/^timeline\b/i.test(t)) return "timeline";
  if (/^(flowchart|graph)\b/i.test(t)) return "graph";
  return null;
}

export async function validateMermaidAsync(codeRaw: string): Promise<{ ok: boolean; error?: string }> {
  const m: any = (window as any).mermaid;
  if (!m) return { ok: false, error: "Mermaid がロードされていません。" };

  const code = preNormalizeMermaid(codeRaw);

  const prevParseError = m.parseError;
  let trappedError: string | null = null;
  m.parseError = (err: any) => {
    const msg = err?.str ?? err?.message ?? String(err);
    trappedError = String(msg);
  };

  try {
    if (typeof m.parse === "function") {
      const r = m.parse(code);
      if (r && typeof r.then === "function") await r;
    }
    else if (m.mermaidAPI?.parse) {
      const r = m.mermaidAPI.parse(code);
      if (r && typeof r.then === "function") await r;
    }
    else if (typeof m.render === "function") {
      const id = "tmp-" + Math.random().toString(36).slice(2);
      const r = m.render(id, code);
      if (r && typeof r.then === "function") await r;
    } else {
      return { ok: false, error: "Mermaid の parse API が見つかりません。" };
    }

    if (trappedError) return { ok: false, error: trappedError };
    return { ok: true };
  } catch (e: any) {
    const msg = e?.str ?? e?.message ?? String(e);
    return { ok: false, error: String(msg) };
  } finally {
    m.parseError = prevParseError;
  }
}

export function extractMermaidBlocks(text: string) {
  const re = /(^|\r?\n)([ \t]*)(`{3,}|~{3,})[ \t]*mermaid([^\n]*)\n([\s\S]*?)(?:\n[ \t]*\3[ \t]*)(?=\r?\n|$)/gmi;
  const blocks: { startOffset: number; endOffset: number; fenceOpen: string; fenceClose: string; info: string; code: string; index: number; }[] = [];
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = re.exec(text)) !== null) {
    const indent = m[2] ?? "";
    const fence = m[3] ?? "";
    const info = (m[4] ?? "").trim();
    const code = m[5] ?? "";
    const relStartInWhole = m[0].indexOf(code);
    if (relStartInWhole < 0) continue;
    const startOffset = (m.index ?? 0) + relStartInWhole;
    const endOffset = startOffset + code.length;
    const fenceOpen = `${indent}${fence}mermaid${info ? " " + info : ""}`;
    const fenceClose = fence;
    blocks.push({ startOffset, endOffset, fenceOpen, fenceClose, info, code, index: idx++ });
  }
  return blocks;
}

/** 差分を計算して色分け表示用のデータを生成 */
export interface DiffLine {
  type: 'unchanged' | 'added' | 'removed';
  content: string;
  lineNumber?: number;
}

export function calculateDiff(original: string, modified: string): DiffLine[] {
  const originalLines = original.split('\n');
  const modifiedLines = modified.split('\n');
  const result: DiffLine[] = [];
  
  // 簡単な行単位の差分計算
  const maxLines = Math.max(originalLines.length, modifiedLines.length);
  
  for (let i = 0; i < maxLines; i++) {
    const originalLine = originalLines[i] || '';
    const modifiedLine = modifiedLines[i] || '';
    
    if (originalLine === modifiedLine) {
      // 変更なし
      result.push({
        type: 'unchanged',
        content: originalLine,
        lineNumber: i + 1
      });
    } else if (originalLine && !modifiedLine) {
      // 削除された行
      result.push({
        type: 'removed',
        content: originalLine,
        lineNumber: i + 1
      });
    } else if (!originalLine && modifiedLine) {
      // 追加された行
      result.push({
        type: 'added',
        content: modifiedLine,
        lineNumber: i + 1
      });
    } else {
      // 変更された行（削除 + 追加として表示）
      result.push({
        type: 'removed',
        content: originalLine,
        lineNumber: i + 1
      });
      result.push({
        type: 'added',
        content: modifiedLine,
        lineNumber: i + 1
      });
    }
  }
  
  return result;
}

