import { describe, expect, it } from "vitest";
import type { Block } from "../lib/session";
import {
  actionGroupOf,
  awaitsUser,
  editVerb,
  groupTurnItems,
  groupTurns,
  isActivityBlock,
  liveEditFor,
  proseSummary,
  thoughtEndTs,
  toolCallLabel,
  toolCallState,
  turnCopyText,
} from "./transcriptActivity";

function shell(
  id: string,
  status = "completed",
  approval?: Block["approval"],
): Block {
  return {
    id,
    role: "tool",
    text: "bash ls",
    tool: { kind: "shell", title: "bash ls", status },
    ...(approval ? { approval } : {}),
  };
}

function edit(id: string, path = "src/App.tsx"): Block {
  const fileName = path.split("/").pop() ?? path;
  return {
    id,
    role: "tool",
    text: `Edited ${path}`,
    tool: {
      kind: "edit",
      title: `Edited ${path}`,
      status: "completed",
      preview: { kind: "write", path, fileName },
    },
  };
}

function read(id: string, path = "src/App.tsx"): Block {
  const fileName = path.split("/").pop() ?? path;
  return {
    id,
    role: "tool",
    text: `Read ${path}`,
    tool: {
      kind: "read",
      title: `Read ${path}`,
      status: "completed",
      preview: { kind: "read", path, fileName },
    },
  };
}

function search(id: string, query = "color tokens"): Block {
  return {
    id,
    role: "tool",
    text: `Find ${query}`,
    tool: {
      kind: "search",
      title: `Find ${query}`,
      status: "completed",
      preview: { kind: "search", query },
    },
  };
}

function note(id: string, text: string): Block {
  return { id, role: "assistant", text };
}

function thought(id: string, text = "Weighing the options."): Block {
  return { id, role: "reasoning", text };
}

describe("groupTurnItems", () => {
  it("keeps consecutive shell calls in one activity stack", () => {
    const items = groupTurnItems([
      shell("a"),
      shell("b"),
      shell("c", "pending"),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "activity",
      blocks: [{ id: "a" }, { id: "b" }, { id: "c" }],
    });
  });

  it("leaves an undecided approval standing alone, outside the run", () => {
    const items = groupTurnItems([
      shell("a"),
      shell("b", "pending", { requestId: 1 }),
      shell("c"),
    ]);
    expect(items.map((item) => item.type)).toEqual(["activity", "block", "activity"]);
  });

  it("splits around assistant text and folds settled edits in", () => {
    const items = groupTurnItems([
      shell("a"),
      { id: "msg", role: "assistant", text: "next I will edit" },
      edit("e"),
      shell("b"),
    ]);
    expect(items.map((item) => item.type)).toEqual(["activity", "block", "activity"]);
    if (items[2]?.type !== "activity") return;
    expect(items[2].blocks.map((block) => block.id)).toEqual(["e", "b"]);
  });

  it("does not split a run across empty assistant placeholders", () => {
    const items = groupTurnItems([
      shell("a"),
      { id: "ghost", role: "assistant", text: "", streaming: true },
      shell("b"),
      shell("c", "pending"),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("activity");
    if (items[0]?.type !== "activity") return;
    expect(items[0].blocks.map((block) => block.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps one run per paragraph when a thought sits between two calls", () => {
    const items = groupTurnItems([
      note("p1", "Looking."),
      read("a"),
      thought("t"),
      shell("b"),
      note("p2", "Done."),
    ]);
    expect(items.map((item) => item.type)).toEqual(["block", "activity", "block"]);
    if (items[1]?.type !== "activity") return;
    expect(items[1].blocks.map((block) => block.id)).toEqual(["a", "t", "b"]);
  });

  it("makes a run of thinking alone its own run", () => {
    const items = groupTurnItems([note("p1", "Hm."), thought("t"), note("p2", "Right.")]);
    expect(items.map((item) => item.type)).toEqual(["block", "activity", "block"]);
  });
});

describe("turnCopyText", () => {
  it("joins assistant and plan markdown from the turn", () => {
    expect(
      turnCopyText([
        { id: "u", role: "user", text: "fix it" },
        { id: "a1", role: "assistant", text: "I'll inspect the file." },
        shell("t"),
        { id: "r", role: "reasoning", text: "thinking" },
        { id: "p", role: "plan", text: "## Plan\n\n- edit App.tsx" },
        { id: "a2", role: "assistant", text: "Done.\n\n```ts\nfixed\n```" },
        { id: "s", role: "system", text: "session error" },
      ]),
    ).toBe(
      "I'll inspect the file.\n\n## Plan\n\n- edit App.tsx\n\nDone.\n\n```ts\nfixed\n```",
    );
  });

  it("returns empty when the turn has no readable output", () => {
    expect(
      turnCopyText([
        { id: "u", role: "user", text: "go" },
        shell("t"),
        { id: "a", role: "assistant", text: "  " },
      ]),
    ).toBe("");
  });
});

describe("groupTurns", () => {
  it("keeps a handoff divider on its own row between providers", () => {
    const turns = groupTurns([
      { id: "u1", role: "user", text: "go" },
      { id: "a1", role: "assistant", text: "working" },
      {
        id: "h1",
        role: "handoff",
        text: "Goal: go",
        handoff: { from: "cursor", to: "claude", status: "ready" },
      },
      { id: "u2", role: "user", text: "continue" },
    ]);
    expect(turns.map((turn) => turn.map((block) => block.id))).toEqual([
      ["u1", "a1"],
      ["h1"],
      ["u2"],
    ]);
  });
});

describe("runs between paragraphs", () => {
  it("folds edits into the activity stack", () => {
    const items = groupTurnItems([shell("a"), edit("b"), shell("c")]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "activity",
      blocks: [{ id: "a" }, { id: "b" }, { id: "c" }],
    });
  });

  it("keeps an edit awaiting approval out of the stack", () => {
    const pending = edit("b");
    pending.approval = { requestId: 1 };
    const items = groupTurnItems([shell("a"), pending]);
    expect(items.map((item) => item.type)).toEqual(["activity", "block"]);
  });

  it("keeps every paragraph full size and folds each run of calls between them", () => {
    const items = groupTurnItems(
      [
        { id: "u", role: "user", text: "cut the release" },
        { id: "a1", role: "assistant", text: "Running the checks first." },
        shell("a"),
        read("a2"),
        { id: "a3", role: "assistant", text: "Checks pass. Bumping:" },
        edit("b"),
        { id: "a4", role: "assistant", text: "Released." },
      ],
    );
    expect(items.map((item) => item.type)).toEqual([
      "block",
      "block",
      "activity",
      "block",
      "activity",
      "block",
    ]);
    if (items[2]?.type !== "activity" || items[4]?.type !== "activity") return;
    expect(items[2].blocks.map((block) => block.id)).toEqual(["a", "a2"]);
    expect(items[4].blocks.map((block) => block.id)).toEqual(["b"]);
    expect(items[5]).toMatchObject({ type: "block", block: { id: "a4" } });
  });

  it("folds a turn of nothing but calls into one group", () => {
    const items = groupTurnItems([shell("a"), read("b"), edit("c")]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "activity" });
  });

  it("keeps the trailing run of prose blocks out of the stack", () => {
    const items = groupTurnItems(
      [
        shell("a"),
        { id: "a1", role: "assistant", text: "Half" },
        { id: "a2", role: "assistant", text: "Done", streaming: true },
      ],
    );
    expect(items.map((item) => item.type)).toEqual([
      "activity",
      "block",
      "block",
    ]);
  });

  it("leaves a paragraph full size when the turn ends on a tool call", () => {
    const items = groupTurnItems(
      [{ id: "a1", role: "assistant", text: "Looking now." }, shell("a")],
    );
    expect(items.map((item) => item.type)).toEqual(["block", "activity"]);
  });

  it("keeps thinking in the stack so a long think is visible", () => {
    const items = groupTurnItems(
      [
        { id: "r", role: "reasoning", text: "**Checking the config**" },
        shell("a"),
        { id: "done", role: "assistant", text: "Done." },
      ],
    );
    expect(items.map((item) => item.type)).toEqual(["activity", "block"]);
    if (items[0]?.type !== "activity") return;
    expect(items[0].blocks.map((block) => block.id)).toEqual(["r", "a"]);
  });

  it("drops a thought the next paragraph repeats word for word", () => {
    const line = "Rejecting now with a short reason, pinning the review.";
    const items = groupTurnItems(
      [
        { id: "r", role: "reasoning", text: `${line}\n` },
        { id: "gap", role: "assistant", text: "" },
        { id: "p", role: "assistant", text: line },
        shell("a"),
        { id: "r2", role: "reasoning", text: "Another thought." },
        { id: "p2", role: "assistant", text: "Something else." },
      ],
    );
    expect(items.map((item) => (item.type === "block" ? item.block.id : "activity"))).toEqual([
      "p",
      "activity",
      "p2",
    ]);
    if (items[1]?.type !== "activity") return;
    expect(items[1].blocks.map((block) => block.id)).toEqual(["a", "r2"]);
  });

});

describe("around a question", () => {
  const question = (id: string, answers?: string[][]): Block => ({
    id,
    role: "tool",
    text: "Pick",
    tool: { kind: "question", title: "Pick", status: answers ? "completed" : "running" },
    question: { sessionId: "s", requestId: id, questions: [], ...(answers ? { answers } : {}) },
  });
  const wall = "The answer the user was asked to read. ".repeat(60);
  const shape = (items: ReturnType<typeof groupTurnItems>) =>
    items.map((item) =>
      item.type === "activity"
        ? `activity(${item.blocks.map((b) => b.id).join(",")})`
        : `block(${item.block.id})`,
    );

  it("keeps the prose before an unanswered question out of the fold", () => {
    expect(wall.length).toBeGreaterThan(2000);
    const items = groupTurnItems(
      [shell("a"), read("b"), note("c", wall), question("q")],
    );
    expect(shape(items)).toEqual(["activity(a,b)", "block(c)", "block(q)"]);
  });

  it("leaves that prose where it was once the question is answered and the agent moved on", () => {
    const items = groupTurnItems(
      [
        shell("a"),
        note("c", wall),
        question("q", [["yes"]]),
        shell("d"),
        read("e"),
        note("f", "Done."),
      ],
    );
    expect(shape(items)).toEqual([
      "activity(a)",
      "block(c)",
      "block(q)",
      "activity(d,e)",
      "block(f)",
    ]);
  });

  it("keeps the prose after the question full size too", () => {
    const items = groupTurnItems(
      [
        note("c", wall),
        question("q", [["yes"]]),
        note("d", "On it."),
        shell("e"),
        note("f", "Done."),
      ],
    );
    expect(shape(items)).toEqual([
      "block(c)",
      "block(q)",
      "block(d)",
      "activity(e)",
      "block(f)",
    ]);
  });

  it("changes nothing for a turn without a question", () => {
    const items = groupTurnItems([shell("a"), read("b"), note("c", wall)]);
    expect(shape(items)).toEqual(["activity(a,b)", "block(c)"]);
  });

  it("treats an approval still waiting on the user like a question", () => {
    const items = groupTurnItems(
      [shell("a"), note("c", wall), shell("p", "pending", { requestId: 1 })],
    );
    expect(shape(items)).toEqual(["activity(a)", "block(c)", "block(p)"]);
  });
});

describe("toolCallLabel", () => {
  it("says what the shell command did, not the tool name", () => {
    expect(
      toolCallLabel({
        id: "a",
        role: "tool",
        text: "git status -s",
        tool: { kind: "execute", title: "git status -s" },
      }),
    ).toBe("Checked git status");
    expect(
      toolCallLabel({
        id: "b",
        role: "tool",
        text: "Skill /code-review",
        tool: { kind: "skill", title: "Skill /code-review" },
      }),
    ).toBe("Used skill /code-review");
  });

  it("renders file-reading bash as a Read/Find label", () => {
    expect(
      toolCallLabel({
        id: "c",
        role: "tool",
        text: "cat src/lib/appearance.ts",
        tool: { kind: "execute", title: "cat src/lib/appearance.ts" },
      }),
    ).toBe("Read src/lib/appearance.ts");
    expect(
      toolCallLabel(
        {
          id: "d",
          role: "tool",
          text: "cat /Users/me/proj/src/lib/appearance.ts",
          tool: {
            kind: "execute",
            title: "cat /Users/me/proj/src/lib/appearance.ts",
          },
        },
        "/Users/me/proj",
      ),
    ).toBe("Read src/lib/appearance.ts");
  });
});

describe("editVerb", () => {
  it("canonicalises past-tense harness phrasing", () => {
    expect(editVerb("Edited src/App.tsx")).toBe("Edit");
    expect(editVerb("Deleted src/old.ts")).toBe("Delete");
    expect(editVerb("Renamed src/a.ts")).toBe("Move");
    expect(editVerb("Created src/new.ts")).toBe("Create");
    expect(editVerb("Wrote src/new.ts")).toBe("Write");
  });

  it("falls back to Edit for unknown phrasing", () => {
    expect(editVerb("Patching src/App.tsx")).toBe("Edit");
    expect(editVerb("")).toBe("Edit");
  });
});

describe("proseSummary", () => {
  it("reduces a paragraph to one plain line", () => {
    expect(
      proseSummary(
        "**Full checks pass** — `cargo fmt` and 134 tests.\n\nBumping:",
      ),
    ).toBe("Full checks pass — cargo fmt and 134 tests.");
  });

  it("skips fenced code and list markers", () => {
    expect(
      proseSummary("```ts\nconst a = 1;\n```\n\n- Ran [checks](x.md)"),
    ).toBe("Ran checks");
  });
});

describe("awaitsUser / toolCallState", () => {
  const question = (id: string, answers?: string[][]): Block => ({
    id,
    role: "tool",
    text: "Pick",
    tool: { kind: "question", title: "Pick", status: answers ? "completed" : "running" },
    question: { sessionId: "s", requestId: id, questions: [], ...(answers ? { answers } : {}) },
  });

  it("an unanswered question waits on the user like an approval does", () => {
    expect(awaitsUser(question("q"))).toBe(true);
    expect(awaitsUser(question("q", [["a"]]))).toBe(false);
    expect(awaitsUser(shell("a", "pending", { requestId: 1 }))).toBe(true);
    expect(awaitsUser(shell("a", "pending", { requestId: 1, decided: "allow" }))).toBe(false);
  });

  it("an auto-denied approval reads as denied, not accepted", () => {
    expect(toolCallState(shell("a", "cancelled", { requestId: 1, decided: "deny", auto: true }))).toBe("rejected");
    expect(toolCallState(shell("a", "completed", { requestId: 1, decided: "allow" }))).toBe("accepted");
    expect(toolCallState(shell("a", "pending", { requestId: 1 }))).toBe("pending");
  });
});

describe("html_render rows", () => {
  const page = (status: string): Block => ({
    id: `page-${status}`,
    role: "tool",
    text: "html_render",
    tool: {
      callId: "c9",
      name: "mcp__app__html_render",
      status,
      detail:
        status === "completed"
          ? JSON.stringify({ htmlRender: { sessionId: "s", pageId: "p1", title: "Chart", height: 300 } })
          : undefined,
    },
  });

  it("keeps a completed page standalone and folds a running call into the activity", () => {
    const running = groupTurnItems([shell("a"), page("running"), shell("b")]);
    expect(running.map((item) => item.type)).toEqual(["activity"]);
    const done = groupTurnItems([shell("a"), page("completed"), shell("b")]);
    expect(done.map((item) => item.type)).toEqual(["activity", "block", "activity"]);
    expect(isActivityBlock(page("completed"))).toBe(false);
    expect(isActivityBlock(page("running"))).toBe(true);
  });
});

describe("actionGroupOf", () => {
  const CWD = "/r";
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join("\n");
  const write = (id: string, path: string, n: number, status = "completed"): Block => ({
    id,
    role: "tool",
    text: "Write",
    tool: { callId: id, name: "Write", kind: "edit", status, input: { file_path: `${CWD}/${path}`, content: lines(n) } },
  });
  const change = (id: string, path: string, adds: number, dels: number, status = "completed"): Block => ({
    id,
    role: "tool",
    text: "Edit",
    tool: {
      callId: id,
      name: "Edit",
      kind: "edit",
      status,
      input: { file_path: `${CWD}/${path}`, old_string: lines(dels), new_string: lines(adds) },
    },
  });
  const bash = (id: string, command: string, status = "completed"): Block => ({
    id,
    role: "tool",
    text: command,
    tool: { callId: id, name: "Bash", kind: "execute", status, input: { command } },
  });

  it("sums every edit's counts and names the dominant kind", () => {
    const g = actionGroupOf(
      [read("r", `${CWD}/src/types.ts`), write("w", "diag.ts", 46), bash("b", "npx convex dev --once"), change("e", "schema.ts", 3, 1)],
      { cwd: CWD },
    );
    expect(g).toMatchObject({ kind: "edit", adds: 49, dels: 1, failed: 0, lone: false });
    expect(g.phrase).toBe("Read types.ts, created diag.ts, ran convex dev and 1 more");
  });

  it("breaks a tie towards the kind earlier in edit, run, research, other", () => {
    expect(actionGroupOf([read("r"), bash("b", "ls")]).kind).toBe("run");
    expect(actionGroupOf([read("r"), read("s"), bash("b", "ls")]).kind).toBe("research");
  });

  it("is lone, no line, for at most one call whatever thoughts sit around it", () => {
    expect(actionGroupOf([read("r")]).lone).toBe(true);
    expect(actionGroupOf([thought("t"), read("r")]).lone).toBe(true);
    expect(actionGroupOf([thought("t")])).toMatchObject({ kind: "think", lone: true });
    expect(actionGroupOf([thought("t"), read("r"), shell("s")]).lone).toBe(false);
  });

  it("takes a running edit's counts from the live edit by path", () => {
    const g = actionGroupOf([change("e", "src/schema.ts", 1, 0, "running")], {
      cwd: CWD,
      live: true,
      liveEdits: {
        "src/schema.ts": { path: "src/schema.ts", kind: "changed", adds: 12, dels: 4, diff: null, state: "editing", startedTs: 0, ts: 0 },
      },
    });
    expect(g).toMatchObject({ adds: 12, dels: 4 });
    expect(g.phrase).toBe("Editing schema.ts");
  });

  it("counts failed and denied calls", () => {
    expect(actionGroupOf([bash("a", "npm test", "failed"), shell("b", "cancelled", { requestId: 1, decided: "deny" }), bash("c", "ls")]).failed).toBe(2);
  });
});

describe("liveEditFor", () => {
  const rec = (path: string) => ({ path, kind: "changed" as const, diff: null, state: "editing" as const, startedTs: 0, ts: 0 });
  it("matches by path, then by suffix either way", () => {
    expect(liveEditFor("a/b.ts", { "a/b.ts": rec("a/b.ts") })?.path).toBe("a/b.ts");
    expect(liveEditFor("/r/a/b.ts", { x: rec("a/b.ts") })?.path).toBe("a/b.ts");
    expect(liveEditFor("b.ts", { x: rec("a/b.ts") })?.path).toBe("a/b.ts");
    expect(liveEditFor("c.ts", { x: rec("a/b.ts") })).toBeUndefined();
    expect(liveEditFor("", { x: rec("a/b.ts") })).toBeUndefined();
  });
});

describe("thoughtEndTs", () => {
  it("is the thought's own end, else the next step's start", () => {
    const blocks: Block[] = [
      { ...thought("t1"), ts: 1, doneTs: 5 },
      { ...thought("t2"), ts: 6 },
      { ...shell("a"), ts: 9 },
    ];
    expect(thoughtEndTs(blocks, 0)).toBe(5);
    expect(thoughtEndTs(blocks, 1)).toBe(9);
    expect(thoughtEndTs([thought("t")], 0)).toBeUndefined();
  });
});
