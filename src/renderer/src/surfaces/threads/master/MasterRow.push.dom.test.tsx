import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionStore } from "../../../lib/tcserver/store";
import { FakeMetaLink, wireMeta } from "../../../test/fakeMetaLink";
import type { BoardRowRef } from "./useMasterModel";

// Every board row draws its state through StatusMark: counting its calls counts the rows that drew again.
const drawn = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../../components/ui/status", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../components/ui/status")>();
  return {
    ...real,
    StatusMark: (props: Parameters<typeof real.StatusMark>[0]) => {
      drawn.calls++;
      return real.StatusMark(props);
    },
  };
});

const { MasterRow } = await import("./MasterRow");

const ref = (id: string): BoardRowRef => ({ key: id, id, planId: null, group: "working", done: false, environmentId: "local", fallback: null, override: null });
const menu = { rowsFor: () => null, onPick: () => {}, onOpenChange: () => {} };
const flush = () => act(() => new Promise((r) => setTimeout(r, 20)));

describe("a board row and the pushes it does not show", () => {
  let link: FakeMetaLink;
  beforeEach(async () => {
    sessionStore.reset();
    link = new FakeMetaLink();
    link.metas = [wireMeta("a"), wireMeta("b"), wireMeta("elsewhere")];
    sessionStore.attach(link);
    await sessionStore.ready();
  });
  afterEach(() => {
    cleanup();
    sessionStore.reset();
  });

  it("draws nothing for 100 pushes of a thread not on the board, or of its own live context; one status change draws its row alone", async () => {
    render(
      <>
        <MasterRow rowRef={ref("a")} landed={false} host={null} onOpen={() => {}} menu={menu} />
        <MasterRow rowRef={ref("b")} landed={false} host={null} onOpen={() => {}} menu={menu} />
      </>,
    );
    await flush();
    const perRow = drawn.calls / 2;
    expect(perRow).toBeGreaterThan(0);
    drawn.calls = 0;

    for (let i = 1; i <= 100; i++) link.push({ push: "session", session: wireMeta("elsewhere", { title: `Elsewhere ${i}` }) });
    await flush();
    for (let i = 1; i <= 100; i++) link.push({ push: "session", session: wireMeta("a", { context: { tokens: 1_000 * i, window: 1_000_000 }, lastEventAt: i }) });
    await flush();
    expect(drawn.calls).toBe(0);

    link.push({ push: "session", session: wireMeta("a", { status: "waiting", statusDetail: "Approve Bash" }) });
    await flush();
    expect(drawn.calls).toBe(perRow);
  });
});
