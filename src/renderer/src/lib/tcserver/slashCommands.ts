import { useEffect, useSyncExternalStore } from "react";
import { client } from "./client";
import type { Link } from "./store";
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

export function commandKey(provider: string, cwd: string): string {
  return `${provider}:${cwd}`;
}

class SlashCommandStore {
  private state: ReadonlyMap<string, CommandEntry> = new Map();
  private inflight = new Map<string, Promise<SlashCommand[]>>();
  private listeners = new Set<() => void>();
  private link: Link | null = null;
  private detach: (() => void)[] = [];

  connect(link: Link = client): void {
    if (this.link === link) return;
    for (const off of this.detach) off();
    this.link = link;
    this.detach = [link.onOpen(() => this.refreshAll())];
  }

  /** Test seam. */
  reset(): void {
    for (const off of this.detach) off();
    this.detach = [];
    this.link = null;
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

  peek(provider: string, cwd: string): SlashCommand[] | undefined {
    return this.state.get(commandKey(provider, cwd))?.commands;
  }

  isStale(provider: string, cwd: string, now = Date.now()): boolean {
    const entry = this.state.get(commandKey(provider, cwd));
    return !entry || now - entry.at >= COMMANDS_STALE_MS;
  }

  /** Re-read one provider's list; concurrent calls share the request. */
  refresh(provider: string, cwd: string): Promise<SlashCommand[]> {
    const key = commandKey(provider, cwd);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    if (!this.link) return Promise.resolve(this.peek(provider, cwd) ?? EMPTY);
    const request = this.link
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

  /** After a reconnect every list the composer has seen may be out of date. */
  private refreshAll(): void {
    for (const key of this.state.keys()) {
      const i = key.indexOf(":");
      void this.refresh(key.slice(0, i), key.slice(i + 1));
    }
  }

  private set(next: ReadonlyMap<string, CommandEntry>): void {
    this.state = next;
    for (const l of this.listeners) l();
  }
}

export const slashCommandStore = new SlashCommandStore();

/**
 * The commands for a composer. Refetches when the provider or cwd changes
 * and each time the `/` trigger opens over a stale entry.
 */
export function useSlashCommands(provider: string, cwd: string, open: boolean): SlashCommand[] {
  const state = useSyncExternalStore(slashCommandStore.subscribe, slashCommandStore.getSnapshot);
  useEffect(() => {
    void slashCommandStore.refresh(provider, cwd);
  }, [provider, cwd]);
  useEffect(() => {
    if (open && slashCommandStore.isStale(provider, cwd)) {
      void slashCommandStore.refresh(provider, cwd);
    }
  }, [open, provider, cwd]);
  return state.get(commandKey(provider, cwd))?.commands ?? EMPTY;
}
