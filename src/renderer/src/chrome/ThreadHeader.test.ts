import { describe, expect, it } from "vitest";
import { chipMenuItems } from "./ThreadHeader";
import type { StripChip } from "./ThreadHeaderStrip";

const chip = (status: StripChip["status"], extra: Partial<StripChip["thread"]> = {}): StripChip => ({
  id: "t1",
  tabId: null,
  live: status !== "idle",
  status,
  unread: false,
  tone: null,
  updatedAt: 1,
  thread: {
    id: "t1",
    status,
    updatedAt: 1,
    projectId: "p1",
    parentId: null,
    archived: false,
    title: "One",
    threadType: "chat",
    ...extra,
  },
});

const ids = (c: StripChip): string[] =>
  chipMenuItems(c).flatMap((i) => (i.kind === "item" ? [i.id] : []));

describe("chipMenuItems", () => {
  it("offers Compact only when no turn is in flight", () => {
    expect(ids(chip("idle"))).toContain("compact");
    expect(ids(chip("running"))).not.toContain("compact");
    expect(ids(chip("paused"))).not.toContain("compact");
    expect(ids(chip("waiting"))).not.toContain("compact");
    expect(ids(chip("idle", { treeHasLiveWork: true }))).not.toContain("compact");
  });

  it("offers Kill background tasks only to a watching thread, beside Stop", () => {
    const watching = ids(chip("watching"));
    expect(watching).toContain("killBackground");
    expect(watching).toContain("stop");
    expect(ids(chip("running"))).not.toContain("killBackground");
    expect(ids(chip("idle"))).not.toContain("killBackground");
  });
});

describe("chipMenuItems: the Mac bridge", () => {
  const state = (macPeer: string | null, extra: { online?: boolean; inherited?: boolean } = {}) => ({
    state: { sessionId: "t1", macPeer, inherited: extra.inherited ?? false, online: extra.online ?? true, registered: [] },
  });
  const item = (c: StripChip, bridge?: Parameters<typeof chipMenuItems>[1]) =>
    chipMenuItems(c, bridge).find((i) => i.kind === "item" && i.id === "mac-bridge");
  it("is offered only for a thread on another host", () => {
    expect(item(chip("idle"))).toBeUndefined();
    expect(item(chip("idle"), state(null))).toMatchObject({ label: "Mac bridge", checked: false, disabled: false });
  });
  it("shows on, offline, and inherited (switched on the parent)", () => {
    expect(item(chip("idle"), state("env_mac"))).toMatchObject({ checked: true, label: "Mac bridge" });
    expect(item(chip("idle"), state("env_mac", { online: false }))).toMatchObject({ checked: true, label: "Mac bridge (offline)" });
    expect(item(chip("idle"), state("env_mac", { inherited: true }))).toMatchObject({ checked: true, disabled: true });
    expect(item(chip("idle"), { state: null })).toMatchObject({ disabled: true });
  });
});
