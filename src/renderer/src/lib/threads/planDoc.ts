/**
 * Pure readers for the plan and report files the views poll: headings
 * split into sections, the task checklist, the report's frontmatter.
 */

export type Section = { heading: string | null; level: number; body: string };

/** Split markdown into heading-led sections, ignoring headings in fences. */
export function splitSections(md: string): Section[] {
  const out: Section[] = [];
  let cur: Section = { heading: null, level: 0, body: "" };
  let fence = false;
  const push = (): void => {
    if (cur.body.trim()) out.push(cur);
  };
  for (const line of md.split("\n")) {
    if (/^(```|~~~)/.test(line.trim())) fence = !fence;
    const m = fence ? null : /^(#{1,3})\s+(.+)/.exec(line);
    if (m) {
      push();
      cur = { heading: m[2].trim(), level: m[1].length, body: line + "\n" };
    } else {
      cur.body += line + "\n";
    }
  }
  push();
  return out;
}

/** The plan's task list: items under a heading that smells like tasks. */
export function planTasks(sections: Section[]): string[] {
  const sec = sections.find((s) => s.heading && /task|step|milestone/i.test(s.heading));
  if (!sec) return [];
  return sec.body
    .split("\n")
    .filter((l) => /^\s*(?:[-*]|\d+[.)])\s+\S/.test(l))
    .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").replace(/^\[[ xX]\]\s*/, "").trim());
}

/** Ticked and unticked checklist items across the whole document. */
export function planProgress(md: string): { done: number; total: number } {
  const done = (md.match(/^\s*[-*]\s+\[x\]/gim) ?? []).length;
  const open = (md.match(/^\s*[-*]\s+\[ \]/gm) ?? []).length;
  return { done, total: done + open };
}

/** The document's first H1, if any. */
export function planHeading(md: string): string | null {
  return md.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
}

export type Report = {
  title: string | null;
  status: string | null;
  summary: string | null;
  body: string;
};

/** A research report: YAML-ish frontmatter (title, status, summary) plus body. */
export function parseReport(md: string): Report {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  const fm = m?.[1] ?? "";
  const get = (k: string): string | null =>
    fm
      .match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, "") ?? null;
  return {
    title: get("title") ?? planHeading(md),
    status: get("status"),
    summary: get("summary"),
    body: m ? md.slice(m[0].length) : md,
  };
}
