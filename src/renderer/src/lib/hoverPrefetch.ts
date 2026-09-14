/**
 * Warm a session's transcript before it is asked for: a tab or thread row
 * hovered for `HOVER_MS` fetches its events, and at boot the two most
 * recently used tabs load once the active one is on screen. Fetches are
 * capped in flight and skipped while the socket is down, so a sweep of the
 * pointer across the strip never floods the server.
 */

export const HOVER_MS = 150;
export const MAX_IN_FLIGHT = 2;
/** Tabs warmed at boot behind the active one. */
export const BOOT_WARM_TABS = 2;

export type PrefetchDeps = {
  load(id: string): Promise<void>;
  isLoaded(id: string): boolean;
  connected(): boolean;
};

export class Prefetcher {
  readonly inFlight = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private hovered: string | null = null;

  constructor(private readonly deps: PrefetchDeps) {}

  /** Fetch `id` now unless it is loaded, already fetching, the socket is
   *  down, or the cap is reached. True when a fetch started. */
  request(id: string): boolean {
    if (this.deps.isLoaded(id) || this.inFlight.has(id)) return false;
    if (!this.deps.connected() || this.inFlight.size >= MAX_IN_FLIGHT) return false;
    this.inFlight.add(id);
    this.deps
      .load(id)
      .catch(() => undefined)
      .finally(() => this.inFlight.delete(id));
    return true;
  }

  /** The pointer is over `key`; after `HOVER_MS` the ids it resolves to fetch. */
  enter(key: string, ids: () => string[] = () => [key]): void {
    this.clearTimer();
    this.hovered = key;
    this.timer = setTimeout(() => {
      this.timer = null;
      for (const id of ids()) this.request(id);
    }, HOVER_MS);
  }

  /** The pointer left `key` (a later `enter` already replaced it). */
  leave(key: string): void {
    if (this.hovered !== key) return;
    this.hovered = null;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

type WarmTab = { id: string; sessionIds: string[]; updatedAt: number };

/** The `count` tabs to warm behind `activeId`: the visit trail's most recent
 *  first, then the freshest by activity. */
export function bootWarmTabs(
  tabs: readonly WarmTab[],
  activeId: string,
  recentIds: readonly string[],
  count = BOOT_WARM_TABS,
): WarmTab[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const out: WarmTab[] = [];
  const add = (tab: WarmTab | undefined) => {
    if (tab && tab.id !== activeId && !out.includes(tab) && out.length < count) out.push(tab);
  };
  for (const id of recentIds) add(byId.get(id));
  for (const tab of [...tabs].sort((a, b) => b.updatedAt - a.updatedAt)) add(tab);
  return out;
}

/** Runs `fn` when the browser is idle; a plain timeout where it has no idle callback. */
export function whenIdle(fn: () => void): void {
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => fn(), { timeout: 2000 });
  else setTimeout(fn, 200);
}
