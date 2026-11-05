/**
 * The soak's reveal report (`--reveal-report`, scripts/measure-renderer-soak.ts):
 * how the streaming reveal stepped in a real window. REVEAL_OBSERVER is
 * evaluated in the page from the script (no app code): a MutationObserver on
 * the document records every new step span (`[data-reveal-step]` carrying
 * `.stream-step`, so a span the markdown re-created for an old step is not
 * counted) with the time, its row and its text length. One observer callback
 * per React commit, so the spans of one step (a step crossing an emphasis
 * splits into several) land together and count as one. `summarizeReveal`
 * turns the records into the step gaps and sizes within each row.
 */

export interface RevealRecord {
  /** performance.now() of the observer callback */
  t: number
  /** the transcript row the span sits in */
  row: string
  chars: number
}

export interface Spread {
  p50: number
  p90: number
  max: number
}

export interface RevealSummary {
  steps: number
  /** ms between two steps of one row */
  gapMs: Spread
  /** chars a step showed */
  chars: Spread
  /** gaps over twice the step (a hold, an underrun, a stall upstream) */
  longGaps: number
}

/** Installs the observer; `window.__revealSteps()` answers the records so far and clears them. */
export const REVEAL_OBSERVER = `(() => {
  if (window.__revealSteps) return 'already';
  const seen = new WeakSet();
  let records = [];
  const note = (el, t) => {
    if (seen.has(el) || !el.classList.contains('stream-step')) return;
    seen.add(el);
    const row = el.closest('[data-row]');
    records.push({ t, row: row ? row.dataset.row : '', chars: (el.textContent || '').length });
  };
  new MutationObserver((mutations) => {
    const t = performance.now();
    for (const m of mutations) for (const node of m.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (node.matches('[data-reveal-step]')) note(node, t);
      for (const el of node.querySelectorAll('[data-reveal-step]')) note(el, t);
    }
  }).observe(document.body, { childList: true, subtree: true });
  window.__revealSteps = () => { const out = records; records = []; return out; };
  return 'installed';
})()`

function spread(values: number[]): Spread {
  if (values.length === 0) return { p50: 0, p90: 0, max: 0 }
  const sorted = values.slice().sort((a, b) => a - b)
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  return { p50: Math.round(at(0.5)), p90: Math.round(at(0.9)), max: Math.round(sorted[sorted.length - 1]!) }
}

/** The records' steps (one per row per callback), their gaps within a row and their sizes. */
export function summarizeReveal(records: RevealRecord[], stepMs: number): RevealSummary {
  const steps = new Map<string, { t: number; row: string; chars: number }>()
  for (const r of records) {
    const key = `${r.row}\u0000${r.t}`
    const step = steps.get(key)
    if (step) step.chars += r.chars
    else steps.set(key, { ...r })
  }
  const byRow = new Map<string, { t: number; chars: number }[]>()
  for (const s of steps.values()) {
    const list = byRow.get(s.row) ?? []
    list.push(s)
    byRow.set(s.row, list)
  }
  const gaps: number[] = []
  const chars: number[] = []
  for (const list of byRow.values()) {
    list.sort((a, b) => a.t - b.t)
    list.forEach((s, i) => {
      chars.push(s.chars)
      if (i > 0) gaps.push(s.t - list[i - 1]!.t)
    })
  }
  return { steps: steps.size, gapMs: spread(gaps), chars: spread(chars), longGaps: gaps.filter((g) => g > 2 * stepMs).length }
}

/** The summary as one line for the log and the report. */
export function revealLine(s: RevealSummary): string {
  return `${s.steps} steps; gap p50 ${s.gapMs.p50} ms, p90 ${s.gapMs.p90} ms, max ${s.gapMs.max} ms; chars p50 ${s.chars.p50}, p90 ${s.chars.p90}, max ${s.chars.max}; ${s.longGaps} gaps over two steps`
}
