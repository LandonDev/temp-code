import { describe, expect, it } from "vitest";
import type { Catalog } from "../lib/projectContext";
import type { Session } from "../lib/session";
import { projectSignals, sessionNeedsYou } from "./useProjectSignals";

const catalog: Catalog = { workspaces: [], projects: [] };

type Signal = Parameters<typeof sessionNeedsYou>[0];

function session(over: Partial<Signal>): Session {
  return {
    cwd: "/repo",
    projectId: null,
    workspaceId: null,
    busy: false,
    status: "idle",
    treeCanContinue: false,
    ...over,
  } as Session;
}

describe("sessionNeedsYou", () => {
  it("counts waiting, errored and continuable threads, nothing else", () => {
    expect(sessionNeedsYou(session({ status: "waiting" }))).toBe(true);
    expect(sessionNeedsYou(session({ status: "error" }))).toBe(true);
    expect(sessionNeedsYou(session({ treeCanContinue: true }))).toBe(true);
    expect(sessionNeedsYou(session({ status: "running", busy: true }))).toBe(false);
    expect(sessionNeedsYou(session({ status: "idle" }))).toBe(false);
  });
});

describe("projectSignals", () => {
  it("puts a waiting thread and an errored one in needsYou, not busy", () => {
    const signals = projectSignals(
      [
        session({ cwd: "/a", status: "waiting", busy: true }),
        session({ cwd: "/b", status: "error" }),
      ],
      catalog,
    );
    expect(signals.needsYou).toEqual(["/a", "/b"]);
    expect(signals.busy).toEqual([]);
  });

  it("leaves a running thread busy", () => {
    const signals = projectSignals(
      [session({ cwd: "/a", status: "running", busy: true })],
      catalog,
    );
    expect(signals.busy).toEqual(["/a"]);
    expect(signals.needsYou).toEqual([]);
  });

  it("drops a folder from busy when another thread there needs you", () => {
    const signals = projectSignals(
      [
        session({ cwd: "/a", status: "running", busy: true }),
        session({ cwd: "/a", status: "waiting" }),
      ],
      catalog,
    );
    expect(signals.busy).toEqual([]);
    expect(signals.needsYou).toEqual(["/a"]);
  });

  it("ignores idle threads", () => {
    expect(projectSignals([session({ cwd: "/a" })], catalog)).toEqual({
      busy: [],
      needsYou: [],
    });
  });

  it("lists a folder once however many threads it holds", () => {
    const signals = projectSignals(
      [
        session({ cwd: "/a", status: "running", busy: true }),
        session({ cwd: "/a", status: "running", busy: true }),
      ],
      catalog,
    );
    expect(signals.busy).toEqual(["/a"]);
  });
});
