import { useEffect, useSyncExternalStore } from "react";
import type { Link } from "../connection";
import type { ProviderId, SlashCommand } from "./types";

/**
 * The server's slash commands per provider and cwd (`commands.list`):
 * skills, commands, prompts, plugins and MCP servers as the harness itself
 * would resolve them. Entries are refetched when they are older than the
 * server's own 30 s cache, so a skill created outside the app shows on the
 * next `/`. A failed list is an empty list, never an error in the composer.
 */

export type CommandEntry = { at: number; commands: SlashCommand[] };

export const COMMANDS_STALE_MS = 30_000;
const EMPTY: SlashCommand[] = [];

export function commandKey(environmentId: string, provider: string, cwd: string): string {
  return `${environmentId}|${provider}:${cwd}`;
}

function splitKey(key: string): [string, string, string] {
  const bar = key.indexOf("|");
  const colon = key.indexOf(":", bar + 1);
  return [key.slice(0, bar), key.slice(bar + 1, colon), key.slice(colon + 1)];
}

class SlashCommandStore {
  private state: ReadonlyMap<string, CommandEntry> = new Map();
  private inflight = new Map<string, Promise<SlashCommand[]>>();
  private listeners = new Set<() => void>();
  private links = new Map<string, { link: Link; detach: (() => void)[] }>();
  private offRegistry: (() => void) | null = null;

  connect(registry: { onLink(listener: (link: Link, event: "added" | "removed") => void): () => void }): void {
    this.offRegistry?.();
    this.offRegistry = registry.onLink((link, event) => {
      if (event === "added") this.attach(link);
      else this.detach(link.environmentId);
    });
  }

  attach(link: Link): void {
    const current = this.links.get(link.environmentId);
    if (current?.link === link) return;
    if (current) this.detach(link.environmentId);
    this.links.set(link.environmentId, { link, detach: [link.onOpen(() => this.refreshAll(link.environmentId))] });
  }

  detach(environmentId: string): void {
    const current = this.links.get(environmentId);
    if (!current) return;
    for (const off of current.detach) off();
    this.links.delete(environmentId);
    this.set(new Map([...this.state].filter(([key]) => !key.startsWith(`${environmentId}|`))));
  }

  /** Test seam. */
  reset(): void {
    this.offRegistry?.();
    this.offRegistry = null;
    for (const { detach } of this.links.values()) for (const off of detach) off();
    this.links.clear();
    this.inflight.clear();
    this.set(new Map());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ReadonlyMap<string, CommandEntry> => this.state;

  peek(environmentId: string, provider: string, cwd: string): SlashCommand[] | undefined {
    return this.state.get(commandKey(environmentId, provider, cwd))?.commands;
  }

  isStale(environmentId: string, provider: string, cwd: string, now = Date.now()): boolean {
    const entry = this.state.get(commandKey(environmentId, provider, cwd));
    return !entry || now - entry.at >= COMMANDS_STALE_MS;
  }

  /** Re-read one provider's list on one host; concurrent calls share the request. */
  refresh(environmentId: string, provider: string, cwd: string): Promise<SlashCommand[]> {
    const key = commandKey(environmentId, provider, cwd);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const link = this.links.get(environmentId)?.link;
    if (!link) return Promise.resolve(this.peek(environmentId, provider, cwd) ?? EMPTY);
    const request = link
      .request<SlashCommand[]>("commands.list", { provider: provider as ProviderId, cwd })
      .then((commands) => (Array.isArray(commands) ? commands : EMPTY))
      .catch(() => EMPTY)
      .then((commands) => {
        const next = new Map(this.state);
        next.set(key, { at: Date.now(), commands });
        this.set(next);
        return commands;
      })
      .finally(() => {
        if (this.inflight.get(key) === request) this.inflight.delete(key);
      });
    this.inflight.set(key, request);
    return request;
  }

  /** After a reconnect every list the composer has seen on that host may be out of date. */
  private refreshAll(environmentId: string): void {
    for (const key of this.state.keys()) {
      const [env, provider, cwd] = splitKey(key);
      if (env === environmentId) void this.refresh(env, provider, cwd);
    }
  }

  private set(next: ReadonlyMap<string, CommandEntry>): void {
    this.state = next;
    for (const l of this.listeners) l();
  }
}

export const slashCommandStore = new SlashCommandStore();

/**
 * The commands for a composer. Fetched only when the `/` trigger opens over
 * a stale entry: a mounted composer costs the server nothing on its own.
 */
export function useSlashCommands(
  environmentId: string,
  provider: string,
  cwd: string,
  open: boolean,
): SlashCommand[] {
  const state = useSyncExternalStore(slashCommandStore.subscribe, slashCommandStore.getSnapshot);
  useEffect(() => {
    if (open && slashCommandStore.isStale(environmentId, provider, cwd)) {
      void slashCommandStore.refresh(environmentId, provider, cwd);
    }
  }, [open, environmentId, provider, cwd]);
  return state.get(commandKey(environmentId, provider, cwd))?.commands ?? EMPTY;
}
