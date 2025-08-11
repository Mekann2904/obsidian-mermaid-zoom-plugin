import { BuildOpts } from "./types";
import { stripCodeFences, withTimeout, inferDiagramType } from "./utils";

/** 出力ノイズ削減用：BOM/ゼロ幅/全角ハイフン等の危険文字を除去/正規化 */
function normalizeSurface(s: string): string {
  return s
    .replace(/\uFEFF/g, "")                         // BOM
    .replace(/[\u200B-\u200D\u2060]/g, "")          // ゼロ幅類
    .replace(/[−ー――]/g, "-")                       // 全角/ダッシュ類 → 半角-
    .replace(/\u3000/g, " ")                         // 全角スペース → 半角
    .replace(/[ \t]+$/gm, "");                       // 行末空白
}

/** ノードラベル内の <br>, <br/>, <br /> を \\n に変換し、必要時はラベルを二重引用符化 */
function preNormalizeMermaid(code: string): string {
  // 1) ブラケット内のみ <br> を \n に
  let out = code.replace(/\[([\s\S]*?)\]/g, (m, inner) => {
    const replaced = inner.replace(/<br\s*\/?>/gi, "\\n");
    return `[${replaced}]`;
  });

  // 2) \\n を含む/記号を含むラベルを二重引用符化（すでに "..." なら維持）
  out = out.replace(/\[([^\]\n]*)\]/g, (m, inner) => {
    const alreadyQuoted = /^".*"$/.test(inner);
    const needsQuote = /\\n|[<>]|"|,|\(|\)|\{|\}|:/.test(inner);
    if (alreadyQuoted || !needsQuote) return m;
    const escaped = inner.replace(/"/g, '\\"');
    return `["${escaped}"]`;
  });

  // 3) 表層正規化（全角/ゼロ幅等）
  return normalizeSurface(out);
}

/** センチネル方式の抽出（なければ素通し）。複数候補があれば最初を採用。*/
function extractFromSentinel(output: string): string {
  const m = output.match(/BEGIN_MERMAID\s*\n([\s\S]*?)\nEND_MERMAID/);
  return m ? m[1].trim() : output.trim();
}

/** Mermaidコードらしさの最終ガード。不要フェンス除去＆表層正規化 */
function sanitizeMermaidOutput(out: string): string {
  const s = stripCodeFences(out).trim();
  return normalizeSurface(s);
}

export function buildGeminiPromptV2(original: string, errorMsg: string, opts: BuildOpts = {}): string {
  const {
    mermaidVersion = "v10.x",
    diagramHint,
    enforceCodeOnly = true,
    useSentinel = true, // 既定でセンチネルオン
  } = opts;

  const dynamicFixes: string[] = [];
  const lowerErr = (errorMsg || "").toLowerCase();

  if (/<br\s*\/?>/i.test(original) || lowerErr.includes("html")) {
    dynamicFixes.push(
      "- ノード内の改行はHTMLではなく \\n を用い、ラベル全体を二重引用符で囲む。",
      "  - 誤: A[テキスト<br>改行]",
      '  - 正: A["テキスト\\n改行"]',
      "- htmlLabels 依存は避ける。必要時のみ init で無効化（下記）。"
    );
  }
  if (lowerErr.includes("lexical error") || lowerErr.includes("unrecognized")) {
    dynamicFixes.push(
      "- 未知記号/全角記号の除去または適切なエスケープ（全角ハイフン・中点・ゼロ幅等）。",
      "- 余分な ``` コードフェンスの削除。"
    );
  }
  if (lowerErr.includes("parse error") || lowerErr.includes("expecting")) {
    dynamicFixes.push(
      "- 各宣言（ノード・エッジ・subgraph・classDef・click 等）は1行1宣言で改行区切り。",
      "- 括弧の対応（[ ], ( ), { }）を確認・修正。"
    );
  }
  if (lowerErr.includes("unknown diagram type") || lowerErr.includes("could not find diagram type")) {
    dynamicFixes.push(
      diagramHint
        ? `- 図種は ${diagramHint} を厳守。`
        : "- 図種は flowchart を既定とし、`flowchart TD` で開始。"
    );
  }
  if (/subgraph/i.test(original)) {
    dynamicFixes.push("- subgraph は必ず `end` で閉じる。`direction` は TB/LR/BT/RL のいずれか。");
  }
  if (/classDef|class\s+[^\n]+/i.test(original)) {
    dynamicFixes.push(
      "- `classDef` は使用前に宣言（`class` の割当より前）。",
      "- `classDef` 名や `class` 対象IDは英数字/アンダースコアが安定。"
    );
  }
  if (/click\s+/i.test(original)) {
    dynamicFixes.push('- `click` 構文: `click ID "URL" "Tooltip"`（空白/記号は二重引用符で）。');
  }
  if (/sequenceDiagram/i.test(original)) {
    dynamicFixes.push(
      "- 矢印は `->`, `->>`, `-->>` 等の正規記法（`-->` は flowchart 用）。",
      "- `participant` の宣言ゆれ（IDと別名）は統一。"
    );
  }
  if (/classDiagram/i.test(original)) {
    dynamicFixes.push("- `classDiagram` は継承/関連の記法を厳守（例：`ClassA <|-- ClassB`）。");
  }
  if (/erDiagram/i.test(original)) {
    dynamicFixes.push("- `erDiagram` はキー/関係記法を厳守（例：`USER ||--o{ ORDER : places`）。");
  }
  if (/gantt/i.test(original)) {
    dynamicFixes.push("- `gantt` は `dateFormat` と `title/section` の整合、日付/期間の形式を統一。");
  }

  dynamicFixes.push(
    '- ラベル内の `"` は `\\"` にエスケープ。',
    "- ノードIDは変更しない（最小修正）。",
    "- 意味不変を守り、必要最小限の分割/統合のみ。"
  );

  const fewShot = [
`[破損→修正1]
(破損)
flowchart TD
  A[タイトル<br>改行] --> B[次]
(修正)
flowchart TD
  A["タイトル\\n改行"] --> B["次"]`,
`[破損→修正2]
(破損)
flowchart LR
  subgraph Group
    X-->Y
  %% end が欠落
(修正)
flowchart LR
  subgraph Group
    X --> Y
  end`,
`[破損→修正3]
(破損)
sequenceDiagram
  participant A as ユーザー
  participant B as サービス
  A-->>B: 要求
  Note over A,B: --> を混用
(修正)
sequenceDiagram
  participant A as ユーザー
  participant B as サービス
  A->>B: 要求`
  ];

  const prohibitions = [
    "禁止事項：",
    "- 図の意味/構造を勝手に変更しない（ノードID・エッジ本数・サブグラフ構成の不必要な変更は禁止）。",
    "- プレースホルダ（TODO/???/…）の挿入は禁止。",
    "- 美観目的の並べ替えや装飾追加は禁止。",
  ].join("\n");

  const outputDiscipline = enforceCodeOnly
    ? [
        "出力規約：",
        "- 出力はMermaidコード **のみ**。説明文・前後の```フェンス```・余分なテキストは一切出力しない。",
        "- 先頭/末尾に空行を入れない。",
      ].join("\n")
    : "出力規約：可能な限りコードのみ。";

  const optionalInit = [
    "init指示は必要な場合のみ：",
    "- HTML依存排除などに限定し、最上部に1行で置く（例：",
    "  `%%{init: {'flowchart': {'htmlLabels': false}}}%%` ）",
  ].join("\n");

  const header = [
    "あなたは Mermaid の構文修復専用アシスタントです。",
    `前提：Mermaid ${mermaidVersion} の文法に準拠する。`,
    diagramHint ? `図種ヒント：${diagramHint}` : "図種ヒント：未指定（不明なら flowchart TD を既定）",
    "目的：構文エラーを解消し、意図を保持した **パース可能** なMermaidコードのみを返す。",
    prohibitions,
    outputDiscipline,
    "",
    "設計原則：",
    "- 最小修正ポリシー（ID/構造を原則維持）。",
    "- 文法違反の確実な解消を最優先。",
    "- 不明点の過剰補完を避ける（文法上必要な最小限のみ補う）。",
    "",
    "よくある直し方：",
    ...dynamicFixes,
    "",
    optionalInit,
    "",
    "チェックリスト（自己検証）：",
    "- 図種宣言は正しいか？（例：`flowchart TD` / `sequenceDiagram` / `classDiagram` 等）",
    "- ステートメントは改行で分離されているか？",
    "- 括弧対応（[ ], ( ), { }）は取れているか？",
    "- `subgraph` の `end` はあるか？",
    "- `classDef` は定義→使用の順序か？",
    "- 引用符とエスケープ（`\"`→`\\\"`）は適切か？",
    "- HTML依存は排除したか？（\\n + 二重引用符）",
    "",
    "参考（破損→修正）：",
    ...fewShot,
  ].join("\n");

  const body = [
    "",
    "【エラーメッセージ】",
    errorMsg || "(なし)",
    "",
    "【元コード】",
    original
  ].join("\n");

  if (useSentinel) {
    return [
      header,
      body,
      "",
      "【出力形式】以下の2行を区切りに、間へ **Mermaidコードのみ** を出力。",
      "BEGIN_MERMAID",
      "（ここに修正後コードのみ）",
      "END_MERMAID"
    ].join("\n");
  }
  return [header, body].join("\n");
}

type GeminiFinishReason = "STOP" | "MAX_TOKENS" | "SAFETY" | "RECITATION" | "OTHER" | string;

/** 単発実行：累積リトライ廃止。APIバージョンは固定（既定 'v1'）。 */
async function callGeminiSingle(
  apiKey: string,
  model: string,
  version: "v1" | "v1beta",
  body: any,
  signal: AbortSignal
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/${version}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Gemini API 認証エラー (${res.status}). APIキーやプロジェクト設定を確認してください。応答: ${text}`);
    }
    if (res.status === 404 && /not found/i.test(text)) {
      throw new Error(`モデルが見つかりません (${version}). モデル名とAPIバージョンの組み合わせを確認してください。応答: ${text}`);
    }
    if (res.status === 429) {
      throw new Error(`レート制限に到達しました (429)。応答: ${text}`);
    }
    if (res.status >= 500) {
      throw new Error(`Gemini サーバーエラー (${res.status})。応答: ${text}`);
    }
    throw new Error(`Gemini API エラー: ${res.status} ${text}`);
  }

  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch {
    throw new Error(`Gemini応答のJSON解析に失敗しました。生データ: ${text.slice(0, 400)}`);
  }

  const candidate = data?.candidates?.[0];
  if (!candidate) {
    const feedback = data?.promptFeedback;
    const reason = feedback?.blockReason ?? "候補が返されませんでした";
    const ratings = (feedback?.safetyRatings ?? []).map((r: any) => `${r.category}:${r.probability}`).join(", ");
    throw new Error(`Geminiからの応答が不正です。理由: ${reason}${ratings ? `（詳細: ${ratings}）` : ""}`);
  }

  const finishReason: GeminiFinishReason = candidate.finishReason;
  if (finishReason && finishReason !== "STOP" && finishReason !== "MAX_TOKENS") {
    throw new Error(`生成が完了しませんでした。finishReason=${finishReason}`);
  }

  // ここでは「空でも」エラーにしない。センチネル抽出後に判断する。
  const out = (candidate?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("");
  return out; // 生テキスト
}

const fixMemo = new Map<string, string>();

/** 公開API（新）：単発のみ。versionは既定 'v1beta'。 */
export async function geminiFixSingle(
  apiKey: string,
  model: string,
  original: string,
  errorMsg: string,
  timeoutMs: number,
  apiVersion: "v1" | "v1beta" = "v1beta"
): Promise<string> {
  const diagram = inferDiagramType(original);

  // 事前正規化（<br/>→\\n, ラベル引用符化 等）
  const pre = preNormalizeMermaid(original);
  const key = `${apiVersion}::${model}::${diagram ?? "unknown"}::${pre}::${errorMsg || ""}`;
  const memo = fixMemo.get(key);
  if (memo) return memo;

  const prompt = buildGeminiPromptV2(pre, errorMsg, {
    diagramHint: diagram ?? undefined,
    enforceCodeOnly: true,
    useSentinel: true,
  });

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      topP: 1.0,
      maxOutputTokens: 2048,
      candidateCount: 1
    }
  };

  const controller = new AbortController();
  const raw = await withTimeout(
    callGeminiSingle(apiKey, model, apiVersion, body, controller.signal),
    timeoutMs,
    controller
  );

  // センチネル抽出 → フェンス除去/正規化
  const middle = extractFromSentinel(raw);
  const result = sanitizeMermaidOutput(middle);

  if (!result) {
    // LLMが空を返した場合でも、preNormalizeの結果を返すと実利があるケースが多い
    if (pre && pre !== original) {
      fixMemo.set(key, pre);
      return pre;
    }
    throw new Error("Geminiが有効な修正案を返しませんでした（空出力）。");
  }

  fixMemo.set(key, result);
  return result;
}

/** 後方互換：内部で単発実行へ委譲（累積リトライは行わない） */
export async function geminiFixWithBackoff(
  apiKey: string,
  model: string,
  original: string,
  errorMsg: string,
  timeoutMs: number
): Promise<string> {
  return geminiFixSingle(apiKey, model, original, errorMsg, timeoutMs, "v1beta");
}

/** originalにinitがある場合、fixedへ再付与（fixed側に既にinitがあれば無変更） */
export function preserveInitIfNeeded(original: string, fixed: string, enabled: boolean): string {
  if (!enabled) return fixed;
  const origLines = original.split(/\r?\n/);
  const origInitLine = origLines.find((l) => l.trim().startsWith("%%{") && /init\s*:/.test(l));
  if (!origInitLine) return fixed;
  const hasInit = /%%\{[^}]*init[^}]*\}%%/.test(fixed);
  if (hasInit) return fixed;
  return `${origInitLine.trim()}\n${fixed}`;
}
