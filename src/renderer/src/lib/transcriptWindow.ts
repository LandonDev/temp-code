/**
 * The transcript's viewport window: which rows to mount for a scroll
 * position, where each sits, and how the scroll offset moves when a row
 * above the reader changes size. Pure maths over row keys and heights, so
 * AgentTranscript can keep its DOM work to measuring and writing.
 *
 * Heights start as estimates and are replaced by measurement; a measured
 * height is remembered by row key, so a row that leaves the window and
 * comes back, or a list that is rebuilt with rows added above, keeps what
 * was measured. Offsets are prefix sums, recomputed lazily from the first
 * row whose size changed.
 */

export type RowRange = { start: number; end: number };

/** A row's place at the top edge of the viewport: the row the edge cuts
 *  through and how far into it the edge sits. */
export type RowAnchor = { key: string; offset: number };

/** Below this many pixels a measurement is the estimate it replaces. */
const MEASURE_EPSILON = 0.5;

export class RowLayout {
  private keys: string[] = [];
  private index = new Map<string, number>();
  private sizes: number[] = [];
  private offsets: number[] = [0];
  private measured = new Map<string, number>();
  private dirtyFrom = 0;

  get length(): number {
    return this.keys.length;
  }

  keyAt(index: number): string | undefined {
    return this.keys[index];
  }

  indexOf(key: string): number {
    return this.index.get(key) ?? -1;
  }

  /** The rows, in order, each with the height to assume until measured. */
  setRows(rows: readonly { key: string; estimate: number }[]): void {
    this.keys = rows.map((row) => row.key);
    this.index = new Map(this.keys.map((key, i) => [key, i]));
    this.sizes = rows.map((row) => this.measured.get(row.key) ?? row.estimate);
    this.offsets.length = this.sizes.length + 1;
    this.dirtyFrom = 0;
  }

  /** A measured height for a row. Answers the row's index and how much it
   *  grew (negative for shrank), or null when nothing changed. */
  measure(key: string, height: number): { index: number; delta: number } | null {
    const index = this.index.get(key);
    if (index === undefined) {
      this.measured.set(key, height);
      return null;
    }
    const delta = height - this.sizes[index];
    this.measured.set(key, height);
    if (Math.abs(delta) < MEASURE_EPSILON) return null;
    this.sizes[index] = height;
    this.dirtyFrom = Math.min(this.dirtyFrom, index);
    return { index, delta };
  }

  hasMeasured(key: string): boolean {
    return this.measured.has(key);
  }

  sizeOf(index: number): number {
    return this.sizes[index] ?? 0;
  }

  private settle(): void {
    if (this.dirtyFrom >= this.sizes.length + 1) return;
    let acc = this.dirtyFrom === 0 ? 0 : this.offsets[this.dirtyFrom];
    for (let i = this.dirtyFrom; i < this.sizes.length; i++) {
      this.offsets[i] = acc;
      acc += this.sizes[i];
    }
    this.offsets[this.sizes.length] = acc;
    this.dirtyFrom = this.sizes.length + 1;
  }

  offsetOf(index: number): number {
    this.settle();
    return this.offsets[Math.max(0, Math.min(index, this.sizes.length))] ?? 0;
  }

  total(): number {
    this.settle();
    return this.offsets[this.sizes.length] ?? 0;
  }

  /** The row whose box holds offset `y` (the last row for anything past the
   *  end, the first for anything before the start). */
  indexAt(y: number): number {
    this.settle();
    const n = this.sizes.length;
    if (n === 0) return 0;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** The rows to mount for a viewport: those that meet it, plus `overscan`
   *  pixels of rows above and below. `end` is exclusive. */
  range(scrollTop: number, clientHeight: number, overscan: number): RowRange {
    const n = this.sizes.length;
    if (n === 0) return { start: 0, end: 0 };
    const start = this.indexAt(scrollTop - overscan);
    const end = Math.min(n, this.indexAt(scrollTop + clientHeight + overscan) + 1);
    return { start, end };
  }

  /** Where the top edge of the viewport sits, by row. */
  anchorAt(scrollTop: number): RowAnchor | null {
    if (this.sizes.length === 0) return null;
    const index = this.indexAt(scrollTop);
    return { key: this.keys[index], offset: scrollTop - this.offsetOf(index) };
  }

  /** The scroll offset that puts an anchor back at the top edge, or null
   *  when its row is gone. */
  scrollTopFor(anchor: RowAnchor): number | null {
    const index = this.index.get(anchor.key);
    if (index === undefined) return null;
    return this.offsetOf(index) + anchor.offset;
  }
}

/** Whether a range covers another (the viewport's need inside what is mounted). */
export function rangeCovers(outer: RowRange, inner: RowRange): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
}

/**
 * How far the scroll offset must move so the reader's row stays put after
 * rows above it changed size: the growth of every changed row that sits
 * above the anchor row. Rows at or below the anchor grow downward, away
 * from the reader, and move nothing.
 */
export function anchorShift(
  changes: readonly { index: number; delta: number }[],
  anchorIndex: number,
): number {
  let shift = 0;
  for (const change of changes) if (change.index < anchorIndex) shift += change.delta;
  return shift;
}
