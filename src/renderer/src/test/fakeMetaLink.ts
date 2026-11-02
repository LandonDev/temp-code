import type { Link } from "../lib/tcserver/store";
import type { ServerPush, SessionMeta } from "../lib/tcserver/types";

/** A host for the store in a test: lists `metas`, answers everything else
 *  with nothing, and pushes what the test hands it. */
export class FakeMetaLink implements Link {
  environmentId = "local";
  profile = "local" as const;
  connected = true;
  metas: Omit<SessionMeta, "environmentId">[] = [];
  private pushes = new Set<(push: ServerPush) => void>();
  request<T>(method: string): Promise<T> {
    return Promise.resolve((method === "session.list" ? this.metas : method === "session.events" ? [] : null) as T);
  }
  onPush(listener: (push: ServerPush) => void): () => void {
    this.pushes.add(listener);
    return () => this.pushes.delete(listener);
  }
  onOpen(): () => void {
    return () => {};
  }
  onClose(): () => void {
    return () => {};
  }
  push(push: ServerPush): void {
    for (const listener of this.pushes) listener(push);
  }
}

/** A meta as a host sends it (no environmentId: the store adds the link's). */
export function wireMeta(id: string, over: Partial<SessionMeta> = {}): Omit<SessionMeta, "environmentId"> {
  return {
    id,
    parentId: null,
    projectId: null,
    workspaceId: null,
    threadType: "implementation",
    planPath: null,
    provider: "claude",
    model: "claude-opus-5-5",
    reasoning: "high",
    agentType: "implementer",
    title: `Thread ${id}`,
    cwd: "/repo",
    status: "running",
    archived: false,
    pinned: false,
    permission: "edits",
    fast: false,
    ultrafast: false,
    context1m: false,
    busySince: 1,
    pausedAt: null,
    frozenActiveElapsed: null,
    nativeId: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as Omit<SessionMeta, "environmentId">;
}
