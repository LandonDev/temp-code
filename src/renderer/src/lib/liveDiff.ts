import type { ToolPreviewLine } from "./session";

/**
 * The `live-edit` push's unified diff (or the whole text of a created
 * file) as preview rows, so an edit row shows disk truth while the call
 * still runs and the harness has no preview yet.
 */
export function liveDiffLines(diff: string, created: boolean): ToolPreviewLine[] {
  const all = diff === "" ? [] : diff.replace(/\r\n/g, "\n").split("\n");
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  if (created || !all.some((l) => /^[@+-]/.test(l))) {
    return all.map((text, i) => ({ number: i + 1, kind: "add", text }));
  }
  const rows: ToolPreviewLine[] = [];
  let newNo = 0;
  for (const l of all) {
    if (l.startsWith("@@")) {
      const m = /\+(\d+)/.exec(l);
      if (m) newNo = Number(m[1]);
      continue;
    }
    if (/^(\+\+\+|---|diff |index |\\)/.test(l)) continue;
    if (l.startsWith("+")) rows.push({ number: newNo++, kind: "add", text: l.slice(1) });
    else if (l.startsWith("-")) rows.push({ number: newNo, kind: "del", text: l.slice(1) });
    else rows.push({ number: newNo++, kind: "context", text: l.startsWith(" ") ? l.slice(1) : l });
  }
  return rows;
}
