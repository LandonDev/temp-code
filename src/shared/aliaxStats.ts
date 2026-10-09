/** Aliax's stats bundle, byte-for-byte the shape its Stats page renders (ported from Aliax src/shared/stats.ts). */
/** One point on a normalised burn curve: history band plus the cycle running now. */
export interface PacePoint {
  frac: number
  hours: number
  p25: number | null
  median: number | null
  p75: number | null
  current: number | null
}

export interface PaceSeries {
  service: string
  label: string
  /** How many completed cycles the band is built from. */
  cycles: number
  nowFrac: number
  nowPercent: number
  normalPercent: number | null
  /** Where this cycle lands if the current rate holds; may exceed 100. */
  projectedPercent: number | null
  exhaustsAtFrac: number | null
  periodMs: number
  points: PacePoint[]
}

export interface NamedValue {
  name: string
  value: number
}

export interface StatsBundle {
  generatedAt: number
  totals: {
    turns: number
    input: number
    output: number
    cache_read: number
    cache_write: number
    eph_1h: number
    eph_5m: number
  }
  pace: PaceSeries[]
  bySurface: NamedValue[]
  byModel: (NamedValue & { turns: number })[]
  byProject: (NamedValue & { turns: number })[]
  byBranch: NamedValue[]
  byTool: (NamedValue & { kind: string })[]
  byEffort: NamedValue[]
  stopReasons: NamedValue[]
  daily: { day: string; claude: number; codex: number }[]
  cacheDaily: { day: string; hit: number }[]
  worstCache: { session: string; project: string; hit: number; output: number }[]
  heatmap: { dow: number; hour: number; value: number }[]
  sessionLengths: { bucket: string; value: number }[]
  events: { kind: string; value: number }[]
  switchesDaily: { day: string; value: number }[]
  utilisation: { account: string; label: string; peak: number; avg: number }[]
  modelDaily: { day: string; model: string; value: number }[]
  flow: { surface: string; model: string; project: string; value: number }[]
}

export interface StatsStatus {
  indexing: boolean
  filesDone: number
  filesTotal: number
  rows: number
}
