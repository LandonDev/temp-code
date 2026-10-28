import { describe, expect, it } from "vitest";
import type { Block } from "../../lib/session";
import type { LiveEditState } from "../../lib/tcserver/store";
import type { TodoItem } from "../../lib/tcserver/todos";
import { activeMs } from "../../lib/threads/rounds";
import {
  changesByTask,
  foldRounds,
  isHiddenPass,
  lastFailure,
  liveFrom,
  needsYou,
  passCost,
  passNumbers,
  passRecord,
  tasksOf,
} from "./implementationBoard";

const user = (id: string, round: number, text: string, extra: Partial<Block> = {}): Block =>
  ({ id, role: "user", text, round, ...extra }) as Block;
const edit = (id: string, path: string, todo: number, adds: number, dels: number, ts = 0, extra: Partial<Block> = {}): Block =>
  ({
    id,
    role: "tool",
    text: "",
    round: 0,
    todo,
    ts,
    doneTs: ts + 10,
    tool: { kind: "edit", name: "Edit", preview: { path, additions: adds, deletions: dels } },
    ...extra,
  }) as unknown as Block;
const todo = (content: string, status: TodoItem["status"]): TodoItem => ({ content, status });

describe("foldRounds and passNumbers", () => {
  it("cuts the blocks into passes and gives a pure Q&A pass no row and no number", () => {
    const blocks = [
      user("u0", 0, "Build it"),
      edit("e0", "src/a.ts", 0, 3, 1),
      user("u1", 1, "What does a.ts do?"),
      { id: "a1", role: "assistant", text: "It adds.", round: 1 } as Block,
      user("u2", 2, "Now test it"),
      { ...edit("e2", "src/a.test.ts", 0, 9, 0), round: 2 } as Block,
    ];
    const rounds = foldRounds(blocks, [todo("test", "in_progress")], [[todo("build", "completed")], []]);
    expect(rounds).toHaveLength(3);
    expect(rounds[0].header?.id).toBe("u0");
    expect(rounds[0].work.map((b) => b.id)).toEqual(["e0"]);
    expect(isHiddenPass(rounds[1])).toBe(true);
    expect(passNumbers(rounds)).toEqual([1, 0, 2]);
  });

  it("leaves bookkeeping edits under .temp-code out of the work", () => {
    const rounds = foldRounds([edit("e", "/repo/.temp-code/plan.md", 0, 1, 0)], [], []);
    expect(rounds[0].work).toEqual([]);
  });
});

describe("tasksOf", () => {
  it("keeps an in-progress task pending when the thread is not running", () => {
    const todos = [todo("a", "completed"), todo("b", "in_progress"), todo("c", "pending")];
    expect(tasksOf(todos, 2, true).map((t) => [t.id, t.state])).toEqual([
      ["2:0", "done"],
      ["2:1", "active"],
      ["2:2", "pending"],
    ]);
    expect(tasksOf(todos, 2, false)[1].state).toBe("pending");
  });

  const run = (id: string, todo: number, ts: number, doneTs?: number): Block =>
    ({ id, role: "tool", text: "", round: 0, todo, ts, doneTs, tool: { kind: "execute", name: "Bash" } }) as unknown as Block;
  const say = (id: string, todo: number, ts: number): Block => ({ id, role: "assistant", text: "", round: 0, todo, ts }) as Block;

  it("gives a done task the time its blocks worked", () => {
    const blocks = [run("a", 0, 1_000, 4_000), say("b", 0, 9_000), run("c", 1, 10_000, 11_000)];
    const tasks = tasksOf([todo("a", "completed"), todo("b", "completed")], 0, true, blocks);
    expect(tasks[0].time).toEqual({ ms: 8_000 });
    expect(tasks[1].time).toEqual({ ms: 1_000 });
  });

  it("gives the running task where its live time counts from, and it adds up to activeMs at that moment", () => {
    const blocks = [run("a", 0, 1_000, 2_000), run("b", 1, 3_000, 6_000), say("c", 1, 5_000)];
    const tasks = tasksOf([todo("a", "completed"), todo("b", "in_progress")], 0, true, blocks);
    const time = tasks[1].time!;
    expect(time.from).toBe(6_000);
    expect(liveFrom(blocks.slice(1))).toBe(6_000);
    const now = 20_000;
    expect(time.ms + (now - time.from!)).toBe(activeMs(blocks.slice(1), now));
  });

  it("gives an in-progress task no live clock while the thread is not running", () => {
    const blocks = [run("a", 0, 1_000, 3_000)];
    const tasks = tasksOf([todo("a", "in_progress")], 0, false, blocks);
    expect(tasks[0].state).toBe("pending");
    expect(tasks[0].time).toEqual({ ms: 2_000 });
  });

  it("gives a pending task no time", () => {
    const tasks = tasksOf([todo("a", "in_progress"), todo("b", "pending")], 0, true, [run("a", 0, 1_000, 3_000)]);
    expect(tasks[1].time).toBeUndefined();
  });

  it("leaves the blocks before the first task out of task 0", () => {
    const blocks = [run("setup", -1, 0, 50_000), run("a", 0, 60_000, 61_000)];
    const tasks = tasksOf([todo("a", "completed")], 0, true, blocks);
    expect(tasks[0].time).toEqual({ ms: 1_000 });
  });
});

describe("changesByTask", () => {
  const disk = (path: string, startedTs: number): LiveEditState => ({
    path,
    kind: "changed",
    adds: 4,
    dels: 2,
    diff: "@@ -1 +1 @@\n-a\n+b",
    state: "settled",
    startedTs,
    ts: startedTs + 100,
  });

  it("sums a file's edits under its task and files setup work apart", () => {
    const blocks = [
      user("u", 0, "go"),
      edit("s", "pkg.json", -1, 1, 0, 100),
      edit("a1", "src/a.ts", 0, 3, 1, 1_000),
      edit("a2", "src/a.ts", 0, 2, 2, 2_000),
      edit("b1", "src/b.ts", 1, 5, 0, 10_000),
    ];
    const round = foldRounds(blocks, [todo("Write a", "completed"), todo("Write b", "completed")], [])[0];
    const groups = changesByTask(round, [], true, false);
    expect(groups.map((g) => g.task)).toEqual(["Setup", "Write a", "Write b"]);
    const a = groups[1].files[0];
    expect([a.name, a.adds, a.dels, a.edits.length]).toEqual(["a.ts", 5, 3, 2]);
  });

  it("files a shell edit under the task running when it began and drops one outside every window", () => {
    const blocks = [user("u", 0, "go"), edit("a", "src/a.ts", 0, 1, 0, 1_000), edit("a2", "src/a.ts", 0, 1, 0, 5_000), edit("b", "src/b.ts", 1, 1, 0, 20_000)];
    const round = foldRounds(blocks, [todo("a", "completed"), todo("b", "completed")], [])[0];
    const groups = changesByTask(round, [disk("gen/out.ts", 4_000), disk("far/away.ts", 12_000)], false, false);
    const shell = groups.flatMap((g) => g.files.filter((f) => f.disk).map((f) => [g.task, f.path]));
    expect(shell).toEqual([["a", "gen/out.ts"]]);
  });

  it("a pass with no tasks is one group with no name", () => {
    const round = foldRounds([user("u", 0, "fix"), edit("e", "x.ts", -1, 1, 1)], [], [])[0];
    const groups = changesByTask(round, [], true, false);
    expect(groups).toHaveLength(1);
    expect(groups[0].task).toBeNull();
  });
});

describe("needsYou and lastFailure", () => {
  it("finds the open approvals and the last error row", () => {
    const work = [
      { id: "ap", role: "tool", text: "", approval: { requestId: 1 } } as unknown as Block,
      { id: "done", role: "tool", text: "", approval: { requestId: 2, decided: "allow" } } as unknown as Block,
      { id: "err:1", role: "system", text: "first" } as Block,
      { id: "err:2", role: "system", text: "second" } as Block,
    ];
    expect(needsYou(work).map((b) => b.id)).toEqual(["ap"]);
    expect(lastFailure(work)?.id).toBe("err:2");
  });
});

describe("passRecord", () => {
  it("keeps when, how long, the model, effort, context, speed and cost", () => {
    const round = foldRounds(
      [
        user("u", 0, "go", { ts: 1_000, turn: { model: "claude-opus-5-5", reasoning: "high", context1m: true, fast: true } } as Partial<Block>),
        edit("e", "a.ts", -1, 1, 0, 2_000),
        { id: "z", role: "assistant", text: "done", round: 0, ts: 65_000 } as Block,
      ],
      [],
      [],
    )[0];
    const rec = passRecord(round, passCost([undefined, 1.5], 1));
    expect(rec).toMatchObject({ endedAt: 65_000, model: "claude-opus-5-5", effort: "High", context: "1M", speed: "Fast", cost: 1.5 });
    expect(rec.workedMs).toBeGreaterThan(1000);
    expect(passCost([0.5, undefined, 2], 2)).toBe(1.5);
  });
});
