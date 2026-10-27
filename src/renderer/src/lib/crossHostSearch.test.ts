import { describe, expect, it, vi } from "vitest";
import { flattenGrouped, groupHits, type AppSearchHit, type ContentHit, type FileHit, type MessageHit } from "./appSearch";
import {
  browseHits,
  dedupePairedFiles,
  foldFileHits,
  formatSeconds,
  hostTimingLabel,
  hostToken,
  hostsMatching,
  matchesProject,
  mergeCrossHost,
  noteHits,
  notePreview,
  parseSearchQuery,
  setQueryToken,
  runCrossHostSearch,
  scoreMessages,
  transcriptHits,
  type SearchSnapshot,
} from "./crossHostSearch";
import { pairWorkspaces } from "./projectPairs";
import type { Environment } from "./connection/types";
import type { WorkspaceMeta } from "./tcserver/types";

const env = (id: string, name: string): Environment => ({ id, name, routes: [], credentialRef: null });
const ws = (environmentId: string, path: string): WorkspaceMeta =>
  ({ id: `${environmentId}:${path}`, name: path.split("/").pop(), path, git: true, createdAt: 1, environmentId }) as WorkspaceMeta;
const pairs = pairWorkspaces([ws("local", "/Users/me/app"), ws("box", "/work/app"), ws("local", "/Users/me/solo")]);

const file = (host: string, path: string, extra: Partial<FileHit> = {}): FileHit => ({
  id: `file:${host}:${path}`,
  kind: "file",
  host,
  path,
  relative: path.split("/").slice(-2).join("/"),
  name: path.split("/").pop() ?? path,
  score: 10,
  positions: [],
  ...extra,
});
const content = (host: string, path: string, line: number, extra: Partial<ContentHit> = {}): ContentHit => ({
  id: `content:${host}:${path}:${line}:1`,
  kind: "content",
  host,
  path,
  relative: path.split("/").slice(-2).join("/"),
  name: path.split("/").pop() ?? path,
  line,
  column: 1,
  preview: "x",
  ...extra,
});
const message = (host: string, sessionId: string, seq: number, rank?: number): MessageHit => ({
  id: `message:${sessionId}:seq-${seq}`,
  kind: "message",
  host,
  sessionId,
  cwd: "/Users/me/app",
  harness: "claude",
  title: sessionId,
  updatedAt: 0,
  seq,
  role: "assistant",
  preview: "p",
  score: 0,
  ...(rank !== undefined ? { rank } : {}),
});

describe("parseSearchQuery", () => {
  it("lifts host:, type: and project: tokens out of the words", () => {
    expect(parseSearchQuery("gateway host:box trace type:thread,file project:Temp-Code")).toEqual({
      text: "gateway trace",
      hosts: ["box"],
      types: ["thread", "file"],
      project: "temp-code",
    });
  });

  it("takes a comma list of hosts, lower-cased, across several tokens", () => {
    expect(parseSearchQuery("fts host:box,Mac").hosts).toEqual(["box", "mac"]);
    expect(parseSearchQuery("host:box fts host:gpu,box").hosts).toEqual(["box", "gpu"]);
  });

  it("treats a token still being typed, an unknown key and an unknown type as words or nothing", () => {
    expect(parseSearchQuery("host: fts")).toEqual({ text: "fts", hosts: null, types: null, project: null });
    expect(parseSearchQuery("url:http type:bogus")).toEqual({ text: "url:http", hosts: null, types: null, project: null });
    expect(parseSearchQuery("type:notes type:files")).toEqual({ text: "", hosts: null, types: ["note", "file"], project: null });
    expect(parseSearchQuery("   ")).toEqual({ text: "", hosts: null, types: null, project: null });
  });
});

describe("hostsMatching", () => {
  const hosts = [env("local", "This Mac"), env("env_box1", "box")];
  it("names a host by name, by id, or by mac for the macOS host; every host without a token", () => {
    expect(hostsMatching(["box"], hosts).map((h) => h.id)).toEqual(["env_box1"]);
    expect(hostsMatching(["env_box1"], hosts).map((h) => h.id)).toEqual(["env_box1"]);
    expect(hostsMatching(["mac"], hosts).map((h) => h.id)).toEqual(["local"]);
    expect(hostsMatching(["mac"], [env("local", "This host"), env("b", "box")], true).map((h) => h.id)).toEqual(["local"]);
    expect(hostsMatching(["mac"], [env("local", "This host"), env("b", "box")], false)).toEqual([]);
    expect(hostsMatching(null, hosts)).toHaveLength(2);
  });

  it("host:mac names this Mac alone beside a macmini box", () => {
    const hosts = [env("local", "This host"), env("box", "macmini")];
    expect(hostsMatching(parseSearchQuery("host:mac").hosts, hosts, true)).toEqual([hosts[0]]);
  });

  it("prefers a whole name or id over a longer host name", () => {
    const hosts = [env("a", "box"), env("b", "box2"), env("box-id", "remote"), env("c", "box-id-long")];
    expect(hostsMatching(["BOX"], hosts)).toEqual([hosts[0]]);
    expect(hostsMatching(["box-id"], hosts)).toEqual([hosts[2]]);
  });

  it("matches substrings when there is no exact match for that token", () => {
    const hosts = [env("a", "macmini"), env("b", "macbook"), env("c", "box")];
    expect(hostsMatching(["mac"], hosts)).toEqual(hosts.slice(0, 2));
    expect(hostsMatching(["mac", "box"], hosts)).toEqual(hosts);
  });

  it("takes the union of every name, in the hosts' order", () => {
    const three = [env("local", "This Mac"), env("env_box1", "box"), env("env_gpu", "gpu")];
    expect(hostsMatching(["gpu", "mac"], three).map((h) => h.id)).toEqual(["local", "env_gpu"]);
    expect(hostsMatching(["zzz", "box"], three).map((h) => h.id)).toEqual(["env_box1"]);
    expect(hostsMatching(["zzz"], three)).toEqual([]);
  });
});

describe("hostToken", () => {
  it("names exactly one host: mac on a Mac, a unique spaceless name, else the id", () => {
    const hosts = [env("local", "This Mac"), env("env_box1", "box"), env("env_box2", "box2")];
    expect(hostToken(hosts[0], hosts, true)).toBe("mac");
    expect(hostToken(hosts[0], hosts, false)).toBe("local");
    expect(hostToken(hosts[1], hosts)).toBe("box");
    expect(hostToken(hosts[2], hosts)).toBe("box2");
  });
});

describe("setQueryToken", () => {
  it("adds a token after the words", () => {
    expect(setQueryToken("gateway  trace", "type", ["thread", "note"])).toBe("gateway trace type:thread,note");
  });
  it("replaces every token of the key and keeps the words in order", () => {
    expect(setQueryToken("type:file gateway host:box trace TYPE:note", "type", ["thread"])).toBe("gateway host:box trace type:thread");
  });
  it("removes the token for null or an empty list", () => {
    expect(setQueryToken("gateway host:box,mac trace", "host", null)).toBe("gateway trace");
    expect(setQueryToken("project:app gateway", "project", [])).toBe("gateway");
  });
  it("parses back to what it wrote", () => {
    expect(parseSearchQuery(setQueryToken("fts", "host", ["box", "mac"])).hosts).toEqual(["box", "mac"]);
  });
});

describe("matchesProject", () => {
  it("matches the pair's name for both hosts' copies, the folder name, and a project hit's name", () => {
    expect(matchesProject(file("box", "/work/app/src/a.ts"), "app", pairs)).toBe(true);
    expect(matchesProject(file("local", "/Users/me/app/src/a.ts"), "APP", pairs)).toBe(true);
    expect(matchesProject(file("box", "/work/app/src/a.ts"), "solo", pairs)).toBe(false);
    expect(matchesProject(message("box", "s", 1), "app", pairs)).toBe(true);
    expect(
      matchesProject({ id: "p", kind: "project", path: "/x/y", name: "Yard", score: 1, positions: [] }, "yard", pairs),
    ).toBe(true);
    expect(matchesProject(file("box", "/work/app/src/a.ts"), null, pairs)).toBe(true);
  });
});

describe("dedupePairedFiles", () => {
  it("folds the same path in two copies of a paired project into the newer copy, naming the other", () => {
    const older = content("local", "/Users/me/app/src/a.ts", 3, { mtime: 100 });
    const newer = content("box", "/work/app/src/a.ts", 3, { mtime: 200 });
    const otherLine = content("box", "/work/app/src/a.ts", 9, { mtime: 200 });
    const out = dedupePairedFiles([older, newer, otherLine], pairs);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ host: "box", line: 3, alsoOn: ["local"], newer: true });
    expect(out[1]).toBe(otherLine);
  });

  it("keeps the first host's copy when neither is newer, without claiming it is", () => {
    const a = file("local", "/Users/me/app/README.md");
    const b = file("box", "/work/app/README.md");
    const out = dedupePairedFiles([a, b], pairs);
    expect(out).toEqual([{ ...a, alsoOn: ["box"], newer: false }]);
    // Order of arrival decides the tie, so the merge sorts hosts first.
    expect(dedupePairedFiles([b, a], pairs)[0]).toMatchObject({ host: "box", alsoOn: ["local"] });
  });

  it("leaves a file outside any pair, or in a pair of one, alone", () => {
    const solo = file("local", "/Users/me/solo/x.ts");
    const stray = file("box", "/tmp/x.ts");
    expect(dedupePairedFiles([solo, stray], pairs)).toEqual([solo, stray]);
  });

  it("a copy with no mtime loses to one that has one", () => {
    const unknown = content("local", "/Users/me/app/src/a.ts", 1);
    const dated = content("box", "/work/app/src/a.ts", 1, { mtime: 5 });
    expect(dedupePairedFiles([unknown, dated], pairs)[0]).toMatchObject({ host: "box", newer: true });
  });
});

describe("foldFileHits", () => {
  it("folds a file's matching lines into its first line, counting the rest", () => {
    const out = foldFileHits(
      [content("local", "/Users/me/solo/app.ts", 9), content("local", "/Users/me/solo/app.ts", 3)],
      pairs,
    );
    expect(out).toEqual([{ ...content("local", "/Users/me/solo/app.ts", 3), more: 1 }]);
  });

  it("counts an exact duplicate line once", () => {
    const line = content("local", "/Users/me/solo/app.ts", 3);
    expect(foldFileHits([line, { ...line, id: "content:memory" }], pairs)).toEqual([line]);
  });

  it("gives a name hit its file's lines: it opens at the first and counts the others", () => {
    const name = file("local", "/Users/me/solo/app.ts");
    const out = foldFileHits(
      [content("local", "/Users/me/solo/app.ts", 7), name, content("local", "/Users/me/solo/app.ts", 3, { column: 5 })],
      pairs,
    );
    expect(out).toEqual([{ ...name, line: 3, column: 5, more: 1 }]);
    expect(foldFileHits([name], pairs)).toEqual([name]);
  });

  it("folds a paired project's lines from both hosts into one row", () => {
    const out = foldFileHits(
      [content("local", "/Users/me/app/src/a.ts", 3, { alsoOn: ["box"], newer: false }), content("box", "/work/app/src/a.ts", 9)],
      pairs,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ host: "local", line: 3, more: 1, alsoOn: ["box"] });
  });

  it("keeps different files, and the same path on unpaired hosts, apart, in their order", () => {
    const message1 = message("local", "a", 1);
    const out = foldFileHits(
      [content("local", "/Users/me/solo/a.ts", 1), message1, content("local", "/Users/me/solo/b.ts", 1), content("box", "/tmp/a.ts", 1), content("local", "/Users/me/solo/a.ts", 2)],
      pairs,
    );
    expect(out.map((hit) => (hit.kind === "content" ? `${hit.host}:${hit.path}:${hit.more ?? 0}` : hit.id))).toEqual([
      "local:/Users/me/solo/a.ts:1",
      "message:a:seq-1",
      "local:/Users/me/solo/b.ts:0",
      "box:/tmp/a.ts:0",
    ]);
  });

  it("runs in the merge, after the paired copies fold", () => {
    const perHost = new Map<string, AppSearchHit[]>([
      ["local", [content("local", "/Users/me/app/src/a.ts", 3, { mtime: 1 }), content("local", "/Users/me/app/src/a.ts", 8, { mtime: 1 })]],
      ["box", [content("box", "/work/app/src/a.ts", 3, { mtime: 2 })]],
    ]);
    const out = mergeCrossHost(perHost, { pairs, hostOrder: ["local", "box"] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ host: "box", line: 3, more: 1, newer: true });
  });
});

describe("browseHits", () => {
  const input = {
    threads: [
      { host: "local", id: "old", cwd: "/Users/me/app", harness: "claude" as const, title: "Old", updatedAt: 1 },
      { host: "box", id: "new", cwd: "/work/alpha", harness: "codex" as const, title: "New", updatedAt: 9 },
    ],
    files: [
      { host: "local", path: "/Users/me/app/b.ts", relative: "b.ts", name: "b.ts" },
      { host: "local", path: "/Users/me/app/a.ts", relative: "a.ts", name: "a.ts" },
    ],
    notes: [
      { host: "box", id: "n1", title: "Plan", body: "# Plan\n\nShip the fold", updatedAt: 2 },
      { host: "local", id: "n2", title: "Later", body: "Later note", updatedAt: 5, sourceCwd: "/Users/me/app" },
    ],
    projects: [{ host: "local", path: "/Users/me/app" }, { host: "box", path: "/work/alpha" }],
    displayTitle: (title: string) => title,
  };

  it("lists each kind per host: threads and notes by recency, files and projects in recents order", () => {
    const perHost = browseHits(input);
    expect([...perHost.keys()].sort()).toEqual(["box", "local"]);
    const merged = mergeCrossHost(perHost, { pairs, hostOrder: ["local", "box"] });
    const flat = flattenGrouped(groupHits(merged, null));
    expect(flat.map((hit) => hit.id)).toEqual([
      "conversation:new",
      "conversation:old",
      "file:local:/Users/me/app/b.ts",
      "file:local:/Users/me/app/a.ts",
      "note:local:n2",
      "note:box:n1",
      "project:/Users/me/app",
      "project:/work/alpha",
    ]);
    expect(flat.find((hit) => hit.id === "note:box:n1")).toMatchObject({ preview: "Ship the fold", title: "Plan" });
  });

  it("goes through the same type: and project: filters as a search", () => {
    const perHost = browseHits(input);
    expect(mergeCrossHost(perHost, { pairs, hostOrder: ["local", "box"], types: ["note"] }).map((hit) => hit.id)).toEqual([
      "note:local:n2",
      "note:box:n1",
    ]);
    expect(mergeCrossHost(perHost, { pairs, hostOrder: ["local", "box"], project: "alpha" }).map((hit) => hit.id)).toEqual([
      "conversation:new",
      "project:/work/alpha",
    ]);
  });

  it("is empty with nothing to list", () => {
    expect(browseHits({ ...input, threads: [], files: [], notes: [], projects: [] }).size).toBe(0);
  });
});

describe("notePreview", () => {
  it("is the first line that is not the title, heading marks dropped", () => {
    expect(notePreview("Plan", "# Plan\n\n## Steps\nmore")).toBe("Steps");
    expect(notePreview("Plan", "Plan")).toBe("");
  });
});

describe("scoreMessages and mergeCrossHost", () => {
  it("scores by match quality and recency, never by host", () => {
    const local = message("local", "a", 1, -2);
    const remote = message("box", "b", 1, -8);
    const scanned = message("box", "c", 1);
    const scored = scoreMessages([local, remote, scanned]) as MessageHit[];
    expect(scored.map((h) => h.score)).toEqual([18, 24, 20]);
    // Swap the hosts: the scores follow the ranks, not the hosts.
    const swapped = scoreMessages([{ ...local, host: "box" }, { ...remote, host: "local" }]) as MessageHit[];
    expect(swapped.map((h) => h.score)).toEqual([18, 24]);
  });

  it("merges every host's hits, orders hosts for the tie-break, and applies type: and project:", () => {
    const perHost = new Map<string, AppSearchHit[]>([
      ["box", [file("box", "/work/app/README.md"), message("box", "b", 1, -3)]],
      ["local", [file("local", "/Users/me/app/README.md"), file("local", "/Users/me/solo/s.ts"), message("local", "a", 1, -1)]],
    ]);
    const all = mergeCrossHost(perHost, { pairs, hostOrder: ["local", "box"] });
    expect(all.map((h) => h.id)).toEqual([
      "file:local:/Users/me/app/README.md",
      "file:local:/Users/me/solo/s.ts",
      "message:a:seq-1",
      "message:b:seq-1",
    ]);
    expect(all[0]).toMatchObject({ alsoOn: ["box"], newer: false });
    expect(mergeCrossHost(perHost, { pairs, hostOrder: ["local", "box"], types: ["thread"] }).map((h) => h.kind)).toEqual([
      "message",
      "message",
    ]);
    expect(mergeCrossHost(perHost, { pairs, hostOrder: ["local", "box"], project: "solo" }).map((h) => h.id)).toEqual([
      "file:local:/Users/me/solo/s.ts",
    ]);
  });
});

describe("runCrossHostSearch", () => {
  const deferred = <T,>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    return { promise, resolve, reject };
  };
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it("streams partial results per host and source, times each host, and skips an offline one", async () => {
    let clock = 1000;
    const snapshots: SearchSnapshot[] = [];
    const boxThreads = deferred<AppSearchHit[]>();
    const boxFiles = deferred<AppSearchHit[]>();
    const macThreads = deferred<AppSearchHit[]>();
    runCrossHostSearch({
      hosts: [
        { environmentId: "local", name: "mac", online: true },
        { environmentId: "box", name: "box", online: true },
        { environmentId: "old", name: "laptop", online: false },
      ],
      sources: (host) => (host.environmentId === "box" ? [boxThreads.promise, boxFiles.promise] : [macThreads.promise]),
      onUpdate: (s) => snapshots.push(s),
      now: () => clock,
    });
    await flush();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].settled).toBe(false);
    expect(snapshots[0].progress.map((p) => `${p.name}:${p.state}`)).toEqual(["mac:searching", "box:searching", "laptop:skipped"]);
    expect(snapshots[0].progress[2].detail).toBe("offline");

    clock = 1300;
    boxThreads.resolve([message("", "b", 1)]);
    await flush();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1].hits.get("box")?.map((h) => h.host)).toEqual(["box"]);
    expect(snapshots[1].progress.find((p) => p.name === "box")).toMatchObject({ state: "searching", elapsedMs: 300 });

    clock = 2200;
    boxFiles.resolve([file("box", "/work/app/x.ts")]);
    await flush();
    expect(snapshots[2].hits.get("box")).toHaveLength(2);
    expect(snapshots[2].progress.find((p) => p.name === "box")).toMatchObject({ state: "done", elapsedMs: 1200 });
    expect(snapshots[2].settled).toBe(false);

    clock = 2250;
    macThreads.resolve([]);
    await flush();
    expect(snapshots[3].settled).toBe(true);
    expect(snapshots[3].progress.find((p) => p.name === "mac")).toMatchObject({ state: "done", elapsedMs: 1250 });
  });

  it("tolerates one failed source, fails a host whose every source failed, and publishes nothing after cancel", async () => {
    const snapshots: SearchSnapshot[] = [];
    const ok = deferred<AppSearchHit[]>();
    const bad = deferred<AppSearchHit[]>();
    const allBad = deferred<AppSearchHit[]>();
    const cancel = runCrossHostSearch({
      hosts: [
        { environmentId: "a", name: "a", online: true },
        { environmentId: "b", name: "b", online: true },
      ],
      sources: (host) => (host.environmentId === "a" ? [ok.promise, bad.promise] : [allBad.promise]),
      onUpdate: (s) => snapshots.push(s),
      now: () => 0,
    });
    bad.reject(new Error("boom"));
    ok.resolve([file("a", "/x")]);
    allBad.reject(new Error("down"));
    await flush();
    const last = snapshots[snapshots.length - 1];
    expect(last.settled).toBe(true);
    expect(last.progress).toEqual([
      { environmentId: "a", name: "a", state: "done", elapsedMs: 0 },
      { environmentId: "b", name: "b", state: "failed", elapsedMs: 0, detail: "down" },
    ]);
    const count = snapshots.length;
    cancel();
    await flush();
    expect(snapshots).toHaveLength(count);
  });

  it("a host with nothing to ask is done at once", async () => {
    const onUpdate = vi.fn();
    runCrossHostSearch({ hosts: [{ environmentId: "a", name: "a", online: true }], sources: () => [], onUpdate, now: () => 0 });
    await flush();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0][0]).toMatchObject({ settled: true, progress: [{ state: "done" }] });
  });
});

describe("hit builders and labels", () => {
  it("titles transcript rows from the host's metas and skips loaded threads", () => {
    const metas = new Map([
      ["s1", { id: "s1", cwd: "/w", harness: "claude" as const, title: "One", updatedAt: 5 }],
      ["s2", { id: "s2", cwd: "/w", harness: "codex" as const, title: "Two", updatedAt: 6 }],
    ]);
    const hits = transcriptHits(
      "box",
      [
        { sessionId: "s1", seq: 3, role: "user", snippet: "hit", ts: 1, rank: -2 },
        { sessionId: "s2", seq: 1, role: "assistant", snippet: "loaded", ts: 1 },
        { sessionId: "gone", seq: 1, role: "assistant", snippet: "x", ts: 1 },
      ],
      metas,
      (id) => id === "s2",
      (title, harness) => `${title}/${harness}`,
    );
    expect(hits).toEqual([
      {
        id: "message:s1:seq-3",
        kind: "message",
        host: "box",
        sessionId: "s1",
        cwd: "/w",
        harness: "claude",
        title: "One/claude",
        updatedAt: 5,
        seq: 3,
        role: "user",
        preview: "hit",
        score: 16,
        rank: -2,
      },
    ]);
  });

  it("builds note hits with the host in the id", () => {
    const [hit] = noteHits("box", [{ id: "n1", title: "T", snippet: "s", updatedAt: Date.now(), sourceCwd: "/w" }]);
    expect(hit).toMatchObject({ id: "note:box:n1", kind: "note", host: "box", noteId: "n1", cwd: "/w" });
    expect(hit.score).toBeGreaterThan(12);
  });

  it("formats the footer line per host state", () => {
    expect(hostTimingLabel({ environmentId: "b", name: "box", state: "done", elapsedMs: 1234 })).toBe("box: 1.2 s");
    expect(hostTimingLabel({ environmentId: "b", name: "box", state: "done", elapsedMs: 80 })).toBe("box: 80 ms");
    expect(hostTimingLabel({ environmentId: "b", name: "box", state: "done", elapsedMs: 12_400 })).toBe("box: 12 s");
    expect(hostTimingLabel({ environmentId: "b", name: "mac", state: "skipped", elapsedMs: 0, detail: "offline" })).toBe(
      "mac: skipped (offline)",
    );
    expect(hostTimingLabel({ environmentId: "b", name: "mac", state: "failed", elapsedMs: 0, detail: "x" })).toBe("mac: failed (x)");
    expect(hostTimingLabel({ environmentId: "b", name: "mac", state: "searching", elapsedMs: 0 })).toBe("mac: …");
    expect(formatSeconds(0)).toBe("1 ms");
  });
});
