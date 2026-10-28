// @vitest-environment jsdom
/**
 * Every thread's chat carries the working strip, an orchestration parent's
 * included, and no transcript draws the live state under it.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";

const h = vi.hoisted(() => ({ liveState: [] as unknown[] }));
vi.mock("../lib/tcserver/store", () => ({ sessionStore: { isDraft: () => false }, useQueue: () => [] }));
vi.mock("../chrome/ConnectionLine", () => ({ useEnvironmentBlock: () => ({ degraded: null, name: "local", text: null }), ConnectionLine: () => null }));
vi.mock("../chrome/Composer", () => ({ Composer: () => <div data-testid="composer" /> }));
vi.mock("../chrome/MacBridgeCards", () => ({ MacBridgeThreadCards: () => null }));
vi.mock("../lib/macBridge", () => ({ useMacBridgeRequests: () => [] }));
vi.mock("../chrome/AppshotFlyIn", () => ({ AppshotFlyIn: () => null }));
vi.mock("../chrome/MessageQueue", () => ({ MessageQueue: () => null }));
vi.mock("../chrome/SessionReview", () => ({ SessionReview: () => null }));
vi.mock("./DeferredMount", () => ({ DeferredMount: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("./AgentTranscript", () => ({
  AgentTranscript: ({ liveState }: { liveState?: boolean }) => {
    h.liveState.push(liveState);
    return <div data-testid="transcript" />;
  },
}));
vi.mock("../lib/tcserver/commands", () => ({ startNow: () => Promise.resolve(), resume: () => Promise.resolve(), killBackground: () => Promise.resolve() }));
vi.mock("../lib/notes", () => ({ createNote: () => {}, noteTitle: () => "" }));
vi.mock("../lib/settings", () => ({ loadNotesEnabled: () => true, subscribeNotesEnabled: () => () => {} }));

import { newSession, type Session } from "../lib/session";
import { useThreadChat, type SessionActions } from "./threadChat";

const noop = () => {};
const actions = { onSubmit: noop, onStop: noop, onApproval: noop } as unknown as SessionActions;

function Chat({ session }: { session: Session }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const chat = useThreadChat({
    session,
    actions,
    visible: true,
    focused: true,
    composerFocused: false,
    rootRef,
    onFocusPane: noop,
    onOpenFile: noop,
    onOpenDiff: noop,
  });
  const slots = chat.renderSlots();
  return (
    <div ref={rootRef}>
      {slots.transcript}
      <div data-testid="strip">{slots.strip}</div>
    </div>
  );
}

const thread = (over: Partial<Session>): Session => ({ ...newSession("local"), id: "t1", ...over }) as Session;

afterEach(() => {
  cleanup();
  h.liveState = [];
});

describe("useThreadChat", () => {
  it("an idle orchestration parent with a live subagent says Watching on its strip", () => {
    const { getByTestId } = render(
      <Chat session={thread({ threadType: "orchestration", status: "idle", background: { tasks: [], agents: ["c1"], watchingSince: null } })} />,
    );
    const strip = getByTestId("strip");
    expect(strip.querySelector("[aria-live]")?.textContent).toContain("Watching");
    expect(strip.textContent).toContain("a subagent");
    expect(h.liveState.every((v) => v === false)).toBe(true);
  });

  it("a running orchestration thread says Working with Stop on its strip, and its transcript draws no live row", () => {
    const { getByTestId } = render(
      <Chat session={thread({ threadType: "orchestration", status: "running", busy: true, busySince: Date.now() })} />,
    );
    const strip = getByTestId("strip");
    expect(strip.textContent).toContain("Working");
    expect([...strip.querySelectorAll("button")].some((b) => b.textContent === "Stop")).toBe(true);
    expect(h.liveState.length).toBeGreaterThan(0);
    expect(h.liveState.every((v) => v === false)).toBe(true);
  });

  it("a chat thread mid-turn draws no live row in its transcript either", () => {
    render(<Chat session={thread({ threadType: "chat", status: "running", busy: true, busySince: Date.now() })} />);
    expect(h.liveState.length).toBeGreaterThan(0);
    expect(h.liveState.every((v) => v === false)).toBe(true);
  });
});
