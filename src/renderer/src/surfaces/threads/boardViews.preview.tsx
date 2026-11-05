import type { ReactNode } from "react";
import { registry } from "../../lib/connection/registry";
import type { Session } from "../../lib/session";
import type { Block } from "../../lib/tcserver/types";
import type { ResearchSource, TodoItem } from "../../lib/tcserver/todos";
import { ImplementationView } from "./ImplementationView";
import { PlanView } from "./PlanView";
import { ResearchView } from "./ResearchView";
import { SplitShell } from "./SplitShell";
import { ChildPane } from "./master/ChildPane";
import { ViewBackContext } from "./viewBack";
import { SessionActionsContext, type SessionActions } from "../threadChat";

/**
 * The board views drawn from plain sessions, for `bun run ui:preview
 * src/renderer/src/surfaces/threads/boardViews.preview.tsx#<Export>`.
 * Rendered by nothing in the app. A plan or report file is read through the
 * host; here a stand-in link answers `file.read` with the fixture's text.
 */

const docs = new Map<string, string>();
const linkOf = registry.linkOf.bind(registry);
registry.linkOf = ((id: string) => {
  const real = linkOf(id);
  return new Proxy(real, {
    get: (target, key, receiver) =>
      key === "request"
        ? async (method: string, params?: { path?: string }) =>
            method === "file.read" && params?.path ? (docs.get(params.path) ?? null) : target.request(method, params)
        : Reflect.get(target, key, receiver),
  });
}) as typeof registry.linkOf;

const chat = (
  <div className="flex flex-1 flex-col justify-end gap-3 p-6 text-sm text-foreground">
    <p className="max-w-[65ch]">The conversation sits here: its transcript and the composer.</p>
  </div>
);
const viewProps = (session: Session) =>
  ({
    session,
    renderChat: () => chat,
    renderSlots: () => null,
    composing: false,
    onArmNewPass: () => {},
    onOpenFile: () => {},
    onOpenDiff: () => {},
  }) as unknown as Parameters<typeof ImplementationView>[0];

const Frame = ({ children }: { children: ReactNode }) => <div className="flex h-[560px] w-full border border-border bg-background">{children}</div>;

const todo = (content: string, status: TodoItem["status"]): TodoItem => ({ content, status });
const edit = (id: string, path: string, todoIx: number, adds: number, dels: number): Block =>
  ({
    id,
    role: "tool",
    text: "",
    round: 0,
    todo: todoIx,
    ts: Date.now() - 120_000,
    doneTs: Date.now() - 119_000,
    tool: { kind: "edit", name: "Edit", preview: { path, additions: adds, deletions: dels, lines: [] } },
  }) as unknown as Block;

/** An implementation thread mid-pass: its tasks and the changes under them. */
export function ImplementationPreview() {
  const session = {
    id: "impl",
    environmentId: "local",
    harness: "claude",
    model: "claude-opus-5-5",
    title: "Ship the raid timer",
    cwd: "/srv/agents/work/plugin",
    status: "running",
    threadType: "implementation",
    loaded: true,
    blocks: [
      { id: "u0", role: "user", text: "Ship the raid timer", round: 0 } as Block,
      edit("e0", "src/main/java/raids/RaidTimer.java", 0, 84, 2),
      edit("e1", "src/main/java/raids/RaidListener.java", 1, 12, 5),
    ],
    thread: {
      todos: [todo("Write the timer", "completed"), todo("Hook it into the listener", "in_progress"), todo("Cover it with a test", "pending")],
      rounds: [],
      costs: [],
      usage: [],
      stopped: false,
      activeTodo: 1,
      round: 0,
    },
  } as unknown as Session;
  return (
    <Frame>
      <ImplementationView {...viewProps(session)} />
    </Frame>
  );
}

const PLAN_PATH = "/srv/agents/work/plugin/.temp-code/plan-raid.md";
docs.set(
  PLAN_PATH,
  "# Ship the raid timer\n\nRaids end on a timer the whole server sees.\n\n## Tasks\n\n- [ ] Write the timer\n- [ ] Hook it into the listener\n- [ ] Cover it with a test\n\n## Risks\n\nA restart mid-raid loses the clock.\n",
);

/** A written, settled plan waiting for its build: titled by its own heading. */
export function PlanPreview() {
  const session = {
    id: "plan",
    environmentId: "local",
    harness: "claude",
    model: "claude-opus-5-5",
    modelSettings: {},
    runtimeMode: "ask",
    title: "Plan the raid timer",
    cwd: "/srv/agents/work/plugin",
    projectId: "p1",
    planPath: PLAN_PATH,
    threadType: "planning",
    status: "idle",
    planCompletedAt: Date.now() - 60_000,
    blocks: [],
  } as unknown as Session;
  return (
    <Frame>
      <PlanView {...viewProps(session)} />
    </Frame>
  );
}

const source = (callId: string, agentId: string, agentLabel: string, over: Partial<ResearchSource>): ResearchSource => ({ callId, agentId, agentLabel, ts: Date.now(), ...over });

/** A research thread with two angles out and its sources landing. */
export function ResearchPreview() {
  const session = {
    id: "r1",
    environmentId: "local",
    harness: "claude",
    title: "Why is the build slow?",
    cwd: "/srv/agents/work/plugin",
    planPath: "/srv/agents/work/plugin/.temp-code/reports/r1.md",
    threadType: "research",
    status: "running",
    blocks: [],
    thread: {
      agents: ["a1", "a2"],
      sources: [
        source("q1", "a1", "Bundler", { query: "vite cold start" }),
        source("c1", "a1", "Bundler", { url: "https://vitejs.dev/guide/dep-pre-bundling", title: "Dependency pre-bundling", claim: "Pre-bundling is cached between runs" }),
        source("q2", "a2", "Cache", { query: "gradle build cache remote" }),
        source("c2", "a2", "Cache", { url: "https://docs.gradle.org/current/userguide/build_cache.html", title: "Build cache" }),
      ],
    },
  } as unknown as Session;
  return (
    <Frame>
      <ResearchView {...viewProps(session)} />
    </Frame>
  );
}

/** A batch child opened from the master board while its rows load: the pane's own bar, Back and the title. */
export function ChildPaneLoadingPreview() {
  return (
    <Frame>
      <SessionActionsContext.Provider value={{} as SessionActions}>
        <ChildPane sessionId="c1" environmentId="local" title="Ship the raid timer" focusComposer={false} onBack={() => {}} onOpenFile={() => {}} onOpenDiff={() => {}} />
      </SessionActionsContext.Provider>
    </Frame>
  );
}

/** A board-type child opened from the master board: one header, its view's, with Back leading it. */
export function ChildBoardHeaderPreview() {
  return (
    <Frame>
      <ViewBackContext.Provider value={{ onBack: () => {}, claim: () => {} }}>
        <SplitShell
          hasBoard
          title="Ship the raid timer"
          detail="2 of 3 tasks"
          board={<div className="flex-1 p-6 text-sm text-muted-foreground">The implementation board</div>}
          chat={chat}
          collapsed={false}
          onToggleChat={() => {}}
        />
      </ViewBackContext.Provider>
    </Frame>
  );
}
