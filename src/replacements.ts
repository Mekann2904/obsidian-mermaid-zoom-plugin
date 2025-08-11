import { Editor } from "obsidian";
import { clamp, offsetToPosFallback } from "./utils";

export function applyReplacementsReverse(editor: Editor, reps: { start: number; end: number; text: string }[]) {
  const doc = editor.getValue();
  reps.sort((a, b) => b.start - a.start);
  for (const r of reps) {
    const s = clamp(r.start, 0, doc.length);
    const e = clamp(r.end, s, doc.length);
    const from = (editor as any).offsetToPos ? (editor as any).offsetToPos(s) : offsetToPosFallback(doc, s);
    const to   = (editor as any).offsetToPos ? (editor as any).offsetToPos(e) : offsetToPosFallback(doc, e);
    editor.replaceRange(r.text, from, to);
  }
}

