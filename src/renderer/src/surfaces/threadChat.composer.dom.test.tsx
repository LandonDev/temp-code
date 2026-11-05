// @vitest-environment jsdom
/**
 * The composer keeps the session it drew until a field it draws changes
 * (COMPOSER_FIELDS, `sameComposerChrome`): a busy master's activity,
 * statusDetail, lastEventAt and activityKind move on every batch push and
 * render no composer. A render of ThreadComposer under a proxy that records
 * every field it reads fails when it starts reading one the list lacks.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
const h = vi.hoisted(() => ({ composers: 0, gesture: null as null | (() => void) }));
vi.mock("../lib/tcserver/store", () => ({
  sessionStore: { isDraft: () => false, metaOf: () => null },
  useQueue: () => [],
  useSessionMetasWhen: () => [],
}));
vi.mock("../chrome/ConnectionLine", () => ({ useEnvironmentBlock: () => ({ degraded: null, name: "local", text: null }), ConnectionLine: () => null }));
vi.mock("../chrome/Composer", () => ({
  Composer: ({ onGesture }: { onGesture: () => void }) => {
    h.composers++;
    h.gesture = onGesture;
    return <div data-testid="composer" />;
  },
}));
vi.mock("../chrome/MacBridgeCards", () => ({ MacBridgeThreadCards: () => null }));
vi.mock("../lib/macBridge", () => ({ useMacBridgeRequests: () => [] }));
vi.mock("../chrome/AppshotFlyIn", () => ({ AppshotFlyIn: () => null }));
vi.mock("../chrome/MessageQueue", () => ({ MessageQueue: () => null, visibleQueue: (items: unknown[]) => items }));
vi.mock("../chrome/SessionReview", () => ({ SessionReview: () => null }));
vi.mock("./DeferredMount", () => ({ DeferredMount: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("./AgentTranscript", () => ({ AgentTranscript: () => <div data-testid="transcript" /> }));
vi.mock("../lib/tcserver/commands", () => ({ startNow: () => Promise.resolve(), resume: () => Promise.resolve(), killBackground: () => Promise.resolve(), preconnect: () => Promise.resolve(), preconnectDraft: () => Promise.resolve() }));
vi.mock("../lib/notes", () => ({ createNote: () => {}, noteTitle: () => "" }));
import { COMPOSER_FIELDS, newSession, type Session } from "../lib/session";
import { ThreadComposer, useThreadChat, type SessionActions } from "./threadChat";

const noop = () => {};
const actions = { onSubmit: noop, onStop: noop, onApproval: noop } as unknown as SessionActions;

afterEach(() => {
  cleanup();
  h.composers = 0;
});

function Chat({ session }: { session: Session }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const chat = useThreadChat({ session, actions, visible: true, focused: true, composerFocused: false, rootRef, onFocusPane: noop, onOpenFile: noop, onOpenDiff: noop });
  return <div ref={rootRef}>{chat.renderSlots().composer}</div>;
}

// One base, spread per push as the store merges a meta: an unchanged field keeps its object.
const BASE = { ...newSession("/repo"), id: "m", environmentId: "local", status: "watching", busy: false, activity: "Waiting on 16 threads", statusDetail: "16 threads", lastEventAt: 1 } as Session;
const master = (over: Partial<Session> = {}): Session => ({ ...BASE, ...over }) as Session;

describe("the composer and the meta it does not draw", () => {
  it("a busy master's activity, status detail, last event and activity kind render no composer; busy does", () => {
    const { rerender } = render(<Chat session={master()} />);
    const first = h.composers;
    expect(first).toBeGreaterThan(0);
    for (let i = 2; i < 12; i++) {
      rerender(<Chat session={master({ activity: `Waiting on ${i} threads`, statusDetail: `${i} threads`, lastEventAt: i, activityKind: i % 2 ? "tool" : "text" } as Partial<Session>)} />);
    }
    expect(h.composers).toBe(first);
    rerender(<Chat session={master({ busy: true, lastEventAt: 99 })} />);
    expect(h.composers).toBe(first + 1);
    // The context meter is the composer's: a context reading renders it.
    rerender(<Chat session={master({ busy: true, lastEventAt: 99, context: { tokens: 40_000, window: 1_000_000 } } as Partial<Session>)} />);
    expect(h.composers).toBe(first + 2);
  });

  it("ThreadComposer reads no session field outside COMPOSER_FIELDS, its gesture's preconnect included", () => {
    const read = new Set<string>();
    const session = new Proxy(master({ projectId: "p1" }), {
      get(target, key, receiver) {
        if (typeof key === "string") read.add(key);
        return Reflect.get(target, key, receiver);
      },
    });
    render(<ThreadComposer session={session} actions={actions} visible focused={false} hotkeys={false} onFocus={noop} onOpenDiff={noop} />);
    h.gesture?.();
    const allowed = new Set<string>(COMPOSER_FIELDS);
    expect([...read].filter((key) => !allowed.has(key))).toEqual([]);
    expect(read.size).toBeGreaterThan(5);
  });
});
