/**
 * The soak's height report (`--height-report`, scripts/measure-renderer-soak.ts
 * `--scene scenarios`): whether a growing box ever jumps instead of gliding.
 * HEIGHT_OBSERVER is evaluated in the page from the script (no app code): a
 * ResizeObserver over every open tool table (`[data-table]`) and code block
 * (`[data-streamdown="code-block"]`), those on screen and those that mount
 * later, records each box's height per callback with the wall clock, so the
 * records line up with the host's steps. ResizeObserver reports once per
 * frame a box's size changed, so a glide is a run of small steps and a jump
 * one step of JUMP_PX or more with the box still on both sides of it
 * (`findJumps`). A box's first record is its mount, never a jump.
 */

/** A height change this large in one frame, with no motion around it, is a jump. */
export const JUMP_PX = 16

export interface HeightRecord {
  /** Date.now() of the observer callback */
  t: number
  /** the box's number, in the order the observer met it */
  box: number
  kind: 'table' | 'code'
  height: number
}

export interface Jump {
  box: number
  kind: HeightRecord['kind']
  from: number
  to: number
  t: number
  /** the step the host had played last when it happened */
  step: string
}

export interface HeightSummary {
  boxes: number
  records: number
  jumps: Jump[]
  /** the jumps per step label */
  perStep: Record<string, number>
}

/** Installs the observer; `window.__heightRecords()` answers the records so far and clears them. */
export const HEIGHT_OBSERVER = `(() => {
  if (window.__heightRecords) return 'already';
  const SELECTOR = '[data-table], [data-streamdown="code-block"]';
  const ids = new WeakMap();
  let next = 0;
  let records = [];
  const observer = new ResizeObserver((entries) => {
    const t = Date.now();
    for (const entry of entries) {
      const el = entry.target;
      if (!ids.has(el)) ids.set(el, ++next);
      const box = entry.borderBoxSize && entry.borderBoxSize[0];
      records.push({ t, box: ids.get(el), kind: el.matches('[data-table]') ? 'table' : 'code', height: Math.round(box ? box.blockSize : entry.contentRect.height) });
    }
  });
  const watch = (root) => {
    if (root.matches && root.matches(SELECTOR)) observer.observe(root);
    if (root.querySelectorAll) for (const el of root.querySelectorAll(SELECTOR)) observer.observe(el);
  };
  watch(document.body);
  new MutationObserver((mutations) => {
    for (const m of mutations) for (const node of m.addedNodes) if (node instanceof Element) watch(node);
  }).observe(document.body, { childList: true, subtree: true });
  window.__heightRecords = () => { const out = records; records = []; return out; };
  return 'installed';
})()`

/**
 * The jumps among `records`: per box, a change of JUMP_PX or more from one
 * record to the next where the box held its height on both sides (the record
 * before the change repeats the one before it, or is the box's first; the one
 * after repeats the new height, or there is none). A glide moves in many small
 * steps, each with motion beside it, so none of them is a jump.
 */
export function findJumps(records: HeightRecord[], steps: { label: string; t: number }[] = []): Jump[] {
  const byBox = new Map<number, HeightRecord[]>()
  for (const r of records) {
    const list = byBox.get(r.box) ?? []
    list.push(r)
    byBox.set(r.box, list)
  }
  const stepAt = (t: number): string => {
    let label = ''
    for (const s of steps) if (s.t <= t) label = s.label
    return label
  }
  const jumps: Jump[] = []
  for (const list of byBox.values()) {
    list.sort((a, b) => a.t - b.t)
    for (let i = 1; i < list.length; i++) {
      const before = list[i - 1]!
      const now = list[i]!
      if (Math.abs(now.height - before.height) < JUMP_PX) continue
      const stillBefore = i === 1 || list[i - 2]!.height === before.height
      const after = list[i + 1]
      const stillAfter = !after || after.height === now.height
      if (stillBefore && stillAfter) jumps.push({ box: now.box, kind: now.kind, from: before.height, to: now.height, t: now.t, step: stepAt(now.t) })
    }
  }
  return jumps.sort((a, b) => a.t - b.t)
}

export function summarizeHeights(records: HeightRecord[], steps: { label: string; t: number }[] = []): HeightSummary {
  const jumps = findJumps(records, steps)
  const perStep: Record<string, number> = {}
  for (const j of jumps) perStep[j.step] = (perStep[j.step] ?? 0) + 1
  return { boxes: new Set(records.map((r) => r.box)).size, records: records.length, jumps, perStep }
}

/** The summary as one line for the log and the report. */
export function heightLine(s: HeightSummary): string {
  const steps = Object.entries(s.perStep).map(([label, n]) => `${label || 'before the first step'} ${n}`)
  return `${s.boxes} boxes, ${s.records} height records, ${s.jumps.length} jumps${steps.length ? `: ${steps.join(', ')}` : ''}`
}
