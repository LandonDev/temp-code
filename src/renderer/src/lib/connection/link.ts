import type { ServerPush } from "@server/shared/contract";
import type { WireProfile } from "@server/shared/wire";
import type { Transport } from "./transport";

/**
 * What a store holds for one environment: a request path, the push
 * stream, and `onOpen` for every replacement session. The supervisor
 * swaps the transport behind it; the stores never see the swap except as
 * one `onOpen`, on which they re-list and re-subscribe.
 */
export type Link = {
  readonly environmentId: string;
  readonly connected: boolean;
  /** The wire profile the live socket opened with. */
  readonly profile: WireProfile;
  request<T>(method: string, params?: unknown): Promise<T>;
  onPush(listener: (push: ServerPush) => void): () => void;
  onOpen(listener: () => void): () => void;
  onClose(listener: () => void): () => void;
};

export class EnvLink implements Link {
  private session: Transport | null = null;
  private detach: (() => void)[] = [];
  private pushListeners = new Set<(push: ServerPush) => void>();
  private openListeners = new Set<() => void>();
  private closeListeners = new Set<() => void>();

  constructor(
    readonly environmentId: string,
    private readonly defaultProfile: WireProfile,
  ) {}

  get connected(): boolean {
    return this.session?.state === "open";
  }

  get profile(): WireProfile {
    return this.session?.profile ?? this.defaultProfile;
  }

  /** The transport behind the link, for the stall log and devtools. */
  get transport(): Transport | null {
    return this.session;
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    const session = this.session;
    if (!session || session.state !== "open") return Promise.reject(new Error("not connected"));
    return session.request<T>(method, params);
  }

  pendingMethods(): string[] {
    return this.session?.pendingMethods() ?? [];
  }

  onPush(listener: (push: ServerPush) => void): () => void {
    this.pushListeners.add(listener);
    return () => this.pushListeners.delete(listener);
  }

  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** The supervisor's hook: a new live session, or none. */
  setSession(session: Transport | null): void {
    if (session === this.session) return;
    for (const off of this.detach) off();
    this.detach = [];
    const had = this.session !== null;
    this.session = session;
    if (!session) {
      if (had) for (const l of this.closeListeners) l();
      return;
    }
    this.detach = [
      session.onPush((push) => {
        for (const l of this.pushListeners) l(push);
      }),
      session.onClose(() => {
        if (this.session !== session) return;
        this.session = null;
        this.detach = [];
        for (const l of this.closeListeners) l();
      }),
    ];
    for (const l of this.openListeners) l();
  }
}
