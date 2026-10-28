// @vitest-environment jsdom
/**
 * A board whose chat is folded keeps the thread's paused row in sight:
 * the strip's own row (Stop, Continue, a master's batch count) under the
 * board's header, drawn once; with the chat shown the chat's strip says it
 * and the board draws nothing.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "../../lib/tcserver/types";

const metas = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("../../lib/tcserver/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/tcserver/store")>()),
  useSessionMetasWhen: (on: boolean) => (on ? metas.list : []),
}));

import { newSession, type Session } from "../../lib/session";
import { heldRowOf, type ChatSlots } from "./chatSlots";
import { SplitShell } from "./SplitShell";
import { WorkingStrip } from "./WorkingStrip";

afterEach(cleanup);

const master = { ...newSession("local"), id: "m", status: "paused", isMaster: true, frozenActiveElapsed: 42_000 } as Session;
const child = (id: string, over: Partial<SessionMeta>) => ({ id, environmentId: "local", masterId: "m", parentId: null, archived: false, status: "idle", ...over }) as SessionMeta;

function view(session: Session, collapsed: boolean) {
  const renderSlots = (): ChatSlots => ({
    transcript: <div data-transcript />,
    strip: <WorkingStrip session={session} onStop={() => {}} onResume={() => {}} />,
    composer: <textarea aria-label="Message" />,
  });
  const source = { renderChat: () => null, renderSlots };
  const slots = renderSlots();
  return render(
    <SplitShell
      board={<p>the board</p>}
      chat={
        <>
          {slots.transcript}
          {slots.strip}
          {slots.composer}
        </>
      }
      hasBoard
      collapsed={collapsed}
      onToggleChat={() => {}}
      title="Batch"
      held={heldRowOf(source, session)}
    />,
  );
}

/** The Continue buttons a person can reach: none inside the folded, inert chat. */
const reachable = (label: string) => [...document.querySelectorAll("button")].filter((b) => b.textContent === label && !b.closest("[inert]"));

describe("the paused row on a folded board", () => {
  it("a paused master with the chat folded shows its paused row once, under the header, with its batch", () => {
    metas.list = [child("a", { status: "paused" }), child("b", { status: "running", treeHasPaused: true }), child("c", { status: "idle" }), child("d", { status: "paused", archived: true })];
    view(master, true);
    const held = document.querySelector("[data-board-held]") as HTMLElement;
    expect(held).toBeTruthy();
    expect(held.textContent).toContain("Paused");
    expect(held.textContent).toContain("and 2 batch threads with it");
    expect(reachable("Continue")).toHaveLength(1);
    expect(reachable("Stop")).toHaveLength(1);
    expect(held.contains(reachable("Continue")[0]!)).toBe(true);
  });

  it("with the chat shown the board draws no paused row; the chat's strip says it once", () => {
    metas.list = [];
    view(master, false);
    expect(document.querySelector("[data-board-held]")).toBeNull();
    expect(reachable("Continue")).toHaveLength(1);
  });

  it("a thread that is not paused gets nothing on its board", () => {
    view({ ...master, status: "running" } as Session, true);
    expect(document.querySelector("[data-board-held]")).toBeNull();
  });
});
