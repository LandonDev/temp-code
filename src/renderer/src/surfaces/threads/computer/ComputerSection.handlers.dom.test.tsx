// @vitest-environment jsdom
/**
 * The container's hand-offs to the list keep their identity: a history push
 * gives the rows new objects, and a row re-renders only when its own call
 * changed, which holds only while onSelect, onToggleRead and onFollow are
 * the same functions (StepRowView's comparator checks them) and an
 * unchanged call keeps its object.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerHistoryCall } from "@server/shared/contract-computer";
import type { ComputerSectionData } from "../../../lib/computerSection";
import type { ComputerViewProps } from "./ComputerView";

const h = vi.hoisted(() => ({ props: [] as unknown[], metas: [{ id: "sub1", title: "Fill in the form" }] as { id: string; title: string }[] }));
vi.mock("./ComputerView", () => ({
  ComputerView: (props: unknown) => {
    h.props.push(props);
    return null;
  },
}));
vi.mock("../../../lib/computerSessions", () => ({ stopComputer: vi.fn(), useComputerEntries: () => [] }));
vi.mock("../../../lib/tcserver/store", () => ({
  useSessionMeta: () => null,
  useSessionTitles: (ids: readonly string[]) => ids.map((id) => h.metas.find((m) => m.id === id)?.title ?? "").join("\u0000"),
}));
vi.mock("../../../lib/computerSection", () => ({ useComputerSection: () => ({ entries: [], keys: [], histories: {}, exists: false, loading: false, live: false }) }));
vi.mock("../../../chrome/lightboxStore", () => ({ openLightbox: vi.fn() }));
vi.mock("../../../lib/computerPreview", () => ({ useComputerPreview: () => ({ state: { status: "starting" }, retry: vi.fn() }) }));
vi.mock("../../../lib/computerHistory", async (original) => ({
  ...(await original<typeof import("../../../lib/computerHistory")>()),
  readHistoryStep: vi.fn(async () => ({})),
}));

import { ComputerSectionBody } from "./ComputerSection";

const call = (n: number): ComputerHistoryCall => ({
  n,
  turn: 1,
  at: n * 1000,
  endedAt: n * 1000 + 400,
  state: "done",
  app: "TextEdit",
  window: "Untitled",
  steps: [{ kind: "click", verb: "Clicked", object: `Step ${n}`, inApp: `Step ${n} in TextEdit`, state: "ok", tier: "ax" }],
  text: false,
  picture: { none: "off" },
  rev: 2,
});
const data = (calls: ComputerHistoryCall[], keys = [{ key: "t1", threadId: "t1" }]): ComputerSectionData => ({
  entries: [],
  keys,
  histories: { t1: { born: 1, calls, more: false, status: "ready" } },
  exists: true,
  loading: false,
  live: false,
});
const last = (): ComputerViewProps => h.props.at(-1) as ComputerViewProps;

afterEach(() => {
  cleanup();
  h.props.length = 0;
  h.metas = [{ id: "sub1", title: "Fill in the form" }];
});

describe("the container's handlers", () => {
  it("are the same functions after a push, a pin and a meta change, and an unchanged call keeps its object", async () => {
    const one = call(1);
    const view = render(<ComputerSectionBody threadId="t1" data={data([one])} />);
    await act(async () => {});
    const first = last();
    // a step lands
    view.rerender(<ComputerSectionBody threadId="t1" data={data([one, call(2)])} />);
    await act(async () => {});
    const pushed = last();
    for (const fn of ["onSelect", "onToggleRead", "onFollow"] as const) expect(pushed[fn], fn).toBe(first[fn]);
    expect(pushed.groups[0].rows.map((r) => r.id)).toEqual(["t1:2:0", "t1:1:0"]);
    expect(pushed.groups[0].rows[1].call).toBe(one);
    // a row is pinned, then followed again
    await act(async () => pushed.onSelect("t1:1:0"));
    expect(last().pinned).toBe(true);
    for (const fn of ["onSelect", "onToggleRead", "onFollow"] as const) expect(last()[fn], fn).toBe(first[fn]);
    await act(async () => last().onFollow());
    expect(last().pinned).toBe(false);
    for (const fn of ["onSelect", "onToggleRead", "onFollow"] as const) expect(last()[fn], fn).toBe(first[fn]);
  });

  it("a meta push that changes no subagent's title leaves the groups as they are; one that does renames its group", async () => {
    const keys = [{ key: "t1", threadId: "t1" }, { key: "sub1", threadId: "sub1" }];
    const d: ComputerSectionData = { ...data([call(1)], keys), histories: { t1: { born: 1, calls: [call(1)], more: false, status: "ready" }, sub1: { born: 1, calls: [call(2)], more: false, status: "ready" } } };
    const view = render(<ComputerSectionBody threadId="t1" data={d} />);
    await act(async () => {});
    const groups = last().groups;
    expect(groups.some((g) => g.heading?.title === "Fill in the form")).toBe(true);
    // another thread's meta moved: a new array, the same titles
    h.metas = [{ id: "sub1", title: "Fill in the form" }, { id: "elsewhere", title: "Unrelated" }];
    view.rerender(<ComputerSectionBody threadId="t1" data={d} />);
    await act(async () => {});
    expect(last().groups).toBe(groups);
    h.metas = [{ id: "sub1", title: "Fill in the order form" }];
    view.rerender(<ComputerSectionBody threadId="t1" data={d} />);
    await act(async () => {});
    expect(last().groups.some((g) => g.heading?.title === "Fill in the order form")).toBe(true);
  });

  it("opening the read while following pins the open row", async () => {
    render(<ComputerSectionBody threadId="t1" data={data([call(1), call(2)])} />);
    await act(async () => {});
    expect(last().pinned).toBe(false);
    await act(async () => last().onToggleRead());
    expect(last()).toMatchObject({ pinned: true, openId: "t1:2:0", read: { open: true } });
    // closing it leaves the row pinned: the person chose it
    await act(async () => last().onToggleRead());
    expect(last()).toMatchObject({ pinned: true, read: { open: false } });
  });
});
