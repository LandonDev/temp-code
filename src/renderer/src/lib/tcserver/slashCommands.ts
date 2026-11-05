import { useEffect, useSyncExternalStore } from "react";
import type { Link } from "../connection";
import type { ProviderId, SlashCommand } from "./types";

/**
 * The server's slash commands per provider and cwd (`commands.list`):
 * skills, commands, prompts, plugins and MCP servers as the harness itself
 * would resolve them. Entries are refetched when they are older than the
 * server's own 30 s cache, so a skill created outside the app shows on the
 * next `/`. A failed list is an empty list marked `failed`, so the menu
 * says it could not load them rather than "No matches".
 */

export type CommandEntry = { at: number; commands: SlashCommand[]; failed?: boolean };

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

  /** No entry, one past the TTL, or a failed one: a failure is asked again at the next open, never held. */
  isStale(environmentId: string, provider: string, cwd: string, now = Date.now()): boolean {
    const entry = this.state.get(commandKey(environmentId, provider, cwd));
    return !entry || !!entry.failed || now - entry.at >= COMMANDS_STALE_MS;
  }

  /** Re-read one provider's list on one host; concurrent calls share the request. */
  refresh(environmentId: string, provider: string, cwd: string): Promise<SlashCommand[]> {
    const key = commandKey(environmentId, provider, cwd);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const link = this.links.get(environmentId)?.link;
    if (!link) {
      // No host to ask: say so once rather than load forever; its link opening refreshes the entry.
      const known = this.state.get(key);
      if (!known) this.store(key, { at: Date.now(), commands: EMPTY, failed: true });
      return Promise.resolve(known?.commands ?? EMPTY);
    }
    const request = link
      .request<SlashCommand[]>("commands.list", { provider: provider as ProviderId, cwd })
      .then((commands): Omit<CommandEntry, "at"> => ({ commands: Array.isArray(commands) ? commands : EMPTY }))
      .catch((error: unknown): Omit<CommandEntry, "at"> => {
        // Still an empty menu, but a refusal (e.g. the path fence) must be
        // tellable apart from a host that simply has no commands.
        console.debug(
          `[slash] commands.list failed for ${provider} on ${environmentId}:`,
          error instanceof Error ? error.message : error,
        );
        return { commands: EMPTY, failed: true };
      })
      .then((entry) => {
        this.store(key, { at: Date.now(), ...entry });
        return entry.commands;
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

  private store(key: string, entry: CommandEntry): void {
    const next = new Map(this.state);
    next.set(key, entry);
    this.set(next);
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
 * `loaded` is false until the first answer for this host, provider and
 * folder lands (a stale entry stays loaded while it refreshes); `failed`
 * says the last ask got no list.
 */
export function useSlashCommands(
  environmentId: string,
  provider: string,
  cwd: string,
  open: boolean,
): SlashCommandsState {
  const state = useSyncExternalStore(slashCommandStore.subscribe, slashCommandStore.getSnapshot);
  useEffect(() => {
    if (open && slashCommandStore.isStale(environmentId, provider, cwd)) {
      void slashCommandStore.refresh(environmentId, provider, cwd);
    }
  }, [open, environmentId, provider, cwd]);
  const entry = state.get(commandKey(environmentId, provider, cwd));
  return entry ? { commands: entry.commands, loaded: true, failed: !!entry.failed } : NOT_LOADED;
}

export type SlashCommandsState = { commands: SlashCommand[]; loaded: boolean; failed: boolean };
const NOT_LOADED: SlashCommandsState = { commands: EMPTY, loaded: false, failed: false };
