import { describe, expect, it } from "vitest";
import type { Block } from "../lib/session";
import {
  activityPhaseTitle,
  activityPreviousLabel,
  awaitsUser,
  buildActivityPhases,
  editVerb,
  groupTurnItems,
  groupTurns,
  lastActivityIndex,
  nestedScrollAbsorbsWheel,
  proseSummary,
  splitActivityRows,
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

  it("does not split a stack when tools are waiting for approval", () => {
    const items = groupTurnItems([
      shell("a"),
      shell("b", "pending", { requestId: 1 }),
      shell("c", "pending", { requestId: 2 }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("activity");
    if (items[0]?.type !== "activity") return;
    expect(items[0].blocks.map((block) => block.id)).toEqual(["a", "b", "c"]);
  });

  it("still splits around assistant text and file edits", () => {
    const items = groupTurnItems([
      shell("a"),
      { id: "msg", role: "assistant", text: "next I will edit" },
      edit("e"),
      shell("b", "pending", { requestId: 1 }),
    ]);
    expect(items.map((item) => item.type)).toEqual([
      "activity",
      "block",
      "block",
      "activity",
    ]);
  });

  it("does not split a stack across empty assistant placeholders", () => {
    const items = groupTurnItems([
      shell("a"),
      { id: "ghost", role: "assistant", text: "", streaming: true },
      shell("b", "pending", { requestId: 1 }),
      shell("c", "pending", { requestId: 2 }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("activity");
    if (items[0]?.type !== "activity") return;
    expect(items[0].blocks.map((block) => block.id)).toEqual(["a", "b", "c"]);
  });
});

describe("splitActivityRows", () => {
  it("keeps the latest completed tool as the headline and inserts approvals above the collapsed rest", () => {
    const rows = splitActivityRows([
      shell("a"),
      shell("find"),
      shell("read", "pending", { requestId: 1 }),
      shell("run", "pending", { requestId: 2 }),
    ]);
    expect(rows.latest?.id).toBe("find");
    expect(rows.pending.map((block) => block.id)).toEqual(["read", "run"]);
    expect(rows.hidden.map((block) => block.id)).toEqual(["a"]);
  });

  it("shows only pending rows when nothing in the stack has finished", () => {
    const rows = splitActivityRows([
      shell("read", "pending", { requestId: 1 }),
      shell("run", "pending", { requestId: 2 }),
    ]);
    expect(rows.latest).toBeUndefined();
    expect(rows.pending.map((block) => block.id)).toEqual(["read", "run"]);
    expect(rows.hidden).toEqual([]);
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

describe("zen mode grouping", () => {
  it("folds edits into the activity stack", () => {
    const items = groupTurnItems([shell("a"), edit("b"), shell("c")], true);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "activity",
      blocks: [{ id: "a" }, { id: "b" }, { id: "c" }],
    });
  });

  it("leaves edits as their own blocks when zen is off", () => {
    const items = groupTurnItems([shell("a"), edit("b"), shell("c")]);
    expect(items.map((item) => item.type)).toEqual([
      "activity",
      "block",
      "activity",
    ]);
  });

  it("keeps an edit awaiting approval out of the stack", () => {
    const pending = edit("b");
    pending.approval = { requestId: 1 };
    const items = groupTurnItems([shell("a"), pending], true);
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
      true,
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
    const items = groupTurnItems([shell("a"), read("b"), edit("c")], true);
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
      true,
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
      true,
    );
    expect(items.map((item) => item.type)).toEqual(["block", "activity"]);
  });

  it("leaves prose alone when zen is off", () => {
    const items = groupTurnItems([
      { id: "a1", role: "assistant", text: "Looking now." },
      shell("a"),
    ]);
    expect(items.map((item) => item.type)).toEqual(["block", "activity"]);
  });

  it("keeps thinking in the stack so a long think is visible", () => {
    const items = groupTurnItems(
      [
        { id: "r", role: "reasoning", text: "**Checking the config**" },
        shell("a"),
        { id: "done", role: "assistant", text: "Done." },
      ],
      true,
    );
    expect(items.map((item) => item.type)).toEqual(["activity", "block"]);
    if (items[0]?.type !== "activity") return;
    expect(items[0].blocks.map((block) => block.id)).toEqual(["r", "a"]);
  });

  it("drops thinking entirely when zen is off", () => {
    const items = groupTurnItems([
      { id: "r", role: "reasoning", text: "thinking" },
      shell("a"),
    ]);
    expect(items).toHaveLength(1);
    if (items[0]?.type !== "activity") return;
    expect(items[0].blocks.map((block) => block.id)).toEqual(["a"]);
  });
});

describe("zen mode around a question", () => {
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
      true,
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
      true,
    );
    expect(shape(items)).toEqual([
      "activity(a)",
      "block(c)",
      "block(q)",
      "activity(d,e)",
      "block(f)",
    ]);
    expect(lastActivityIndex(items)).toBe(3);
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
      true,
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
    const items = groupTurnItems([shell("a"), read("b"), note("c", wall)], true);
    expect(shape(items)).toEqual(["activity(a,b)", "block(c)"]);
  });

  it("treats an approval still waiting on the user like a question", () => {
    const items = groupTurnItems(
      [shell("a"), note("c", wall), shell("p", "pending", { requestId: 1 })],
      true,
    );
    expect(shape(items)).toEqual(["activity(a)", "block(c)", "block(p)"]);
  });
});

describe("activityPreviousLabel", () => {
  it("counts what is waiting behind the disclosure", () => {
    expect(activityPreviousLabel(1)).toBe("+1 previous tool call");
    expect(activityPreviousLabel(4)).toBe("+4 previous tool calls");
  });
});

describe("buildActivityPhases", () => {
  it("groups a run of calls by the kind of work, keyed on its first step", () => {
    const phases = buildActivityPhases([
      search("s1"),
      read("r1", "src/globals.css"),
      read("r2", "src/layout.tsx"),
      edit("e1", "src/globals.css"),
      edit("e2", "src/theme.ts"),
    ]);
    expect(phases).toHaveLength(2);
    expect(phases[0]).toMatchObject({ id: "s1", kind: "research" });
    expect(phases[0].steps.map((block) => block.id)).toEqual([
      "s1",
      "r1",
      "r2",
    ]);
    expect(phases[1]).toMatchObject({ id: "e1", kind: "edit" });
    expect(phases[1].steps.map((block) => block.id)).toEqual(["e1", "e2"]);
  });

  it("starts a group when the work changes shape, narrated or not", () => {
    const phases = buildActivityPhases([
      read("r1", "a.ts"),
      read("r2", "b.ts"),
      edit("e1", "a.ts"),
      edit("e2", "b.ts"),
    ]);
    expect(phases.map((phase) => phase.kind)).toEqual(["research", "edit"]);
  });

  it("folds a lone uninvited call into the group before it", () => {
    const phases = buildActivityPhases([
      edit("e1", "a.ts"),
      read("r1", "a.ts"),
      edit("e2", "b.ts"),
    ]);
    expect(phases).toHaveLength(1);
    expect(phases[0].kind).toBe("edit");
    expect(phases[0].steps.map((block) => block.id)).toEqual([
      "e1",
      "r1",
      "e2",
    ]);
  });

  it("gives a turn that only thought a group to sit in", () => {
    const phases = buildActivityPhases([thought("r")]);
    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({ id: "r", kind: "think" });
    expect(phases[0].steps.map((block) => block.id)).toEqual(["r"]);
  });

  it("keeps reasoning inside the group instead of titling it", () => {
    const phases = buildActivityPhases([
      thought("t1"),
      search("s1"),
      thought("t2"),
      search("s2"),
    ]);
    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({ id: "t1", kind: "research" });
    expect(phases[0].steps.map((block) => block.id)).toEqual([
      "t1",
      "s1",
      "t2",
      "s2",
    ]);
  });

  it("moves a thought at the end of a group into the group it introduced", () => {
    const phases = buildActivityPhases([
      read("r1", "a.ts"),
      read("r2", "b.ts"),
      thought("t1", "Now to apply the change."),
      edit("e1", "a.ts"),
      edit("e2", "b.ts"),
    ]);
    expect(phases.map((phase) => phase.kind)).toEqual(["research", "edit"]);
    expect(phases[0].steps.map((block) => block.id)).toEqual(["r1", "r2"]);
    expect(phases[1].steps.map((block) => block.id)).toEqual([
      "t1",
      "e1",
      "e2",
    ]);
  });

  it("never carries a headline: prose stands outside every group", () => {
    const phases = buildActivityPhases([thought("t1"), search("s1")]);
    expect(phases).toHaveLength(1);
    expect(phases[0]).not.toHaveProperty("headline");
  });
});

describe("activityPhaseTitle", () => {
  const title = (blocks: Block[], live = false) =>
    activityPhaseTitle(buildActivityPhases(blocks)[0], live);

  it("says Thinking or Thought for a group that only reasoned", () => {
    expect(title([thought("t1"), thought("t2")], true)).toBe("Thinking");
    expect(title([thought("t1"), thought("t2")])).toBe("Thought");
  });

  it("counts failures in the line", () => {
    expect(title([shell("a"), shell("b", "failed")])).toBe(
      "Listed files (1 failed)",
    );
  });

  it("says what the calls add up to, in the tense of the moment", () => {
    expect(title([read("r1", "a.ts"), read("r2", "b.ts")], true)).toBe(
      "Reading 2 files",
    );
    expect(title([read("r1", "a.ts"), read("r2", "b.ts")])).toBe(
      "Read 2 files",
    );
    expect(title([read("r1", "src/index.css")])).toBe("Read src/index.css");
    expect(title([search("s1"), search("s2")])).toBe("Searched for color tokens");
    expect(title([search("s1"), read("r1")])).toBe(
      "Searched for color tokens · Read src/App.tsx",
    );
    expect(title([edit("e1", "a.ts"), edit("e2", "b.ts")])).toBe(
      "Edited 2 files",
    );
    expect(title([shell("a"), shell("b")])).toBe("Listed files");
    expect(title([shell("a")], true)).toBe("Listing files");
  });
});

describe("lastActivityIndex", () => {
  it("points at the last group of the turn", () => {
    const items = groupTurnItems(
      [
        { id: "u", role: "user", text: "go" },
        shell("a"),
        { id: "p", role: "plan", text: "## Plan" },
        shell("b"),
        { id: "done", role: "assistant", text: "Done." },
      ],
      true,
    );
    expect(lastActivityIndex(items)).toBe(3);
  });

  it("returns -1 for a turn that ran no tools", () => {
    expect(
      lastActivityIndex(
        groupTurnItems([{ id: "a", role: "assistant", text: "Hi." }], true),
      ),
    ).toBe(-1);
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
    ).toBe("Used Skill /code-review");
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

describe("nestedScrollAbsorbsWheel", () => {
  const overflowing = {
    scrollTop: 40,
    scrollHeight: 200,
    clientHeight: 80,
  };

  it("lets the parent handle the wheel when the list does not overflow", () => {
    expect(
      nestedScrollAbsorbsWheel(
        { scrollTop: 0, scrollHeight: 80, clientHeight: 80 },
        -20,
      ),
    ).toBe(false);
  });

  it("consumes scrolling that still has room inside the list", () => {
    expect(nestedScrollAbsorbsWheel(overflowing, -20)).toBe(true);
    expect(nestedScrollAbsorbsWheel(overflowing, 20)).toBe(true);
  });

  it("releases the wheel at the edges so the transcript can take over", () => {
    expect(
      nestedScrollAbsorbsWheel({ ...overflowing, scrollTop: 0 }, -20),
    ).toBe(false);
    expect(
      nestedScrollAbsorbsWheel({ ...overflowing, scrollTop: 120 }, 20),
    ).toBe(false);
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
    const rows = splitActivityRows([shell("a"), question("q")]);
    expect(rows.pending.map((b) => b.id)).toEqual(["q"]);
  });

  it("an auto-denied approval reads as denied, not accepted", () => {
    expect(toolCallState(shell("a", "cancelled", { requestId: 1, decided: "deny", auto: true }))).toBe("rejected");
    expect(toolCallState(shell("a", "completed", { requestId: 1, decided: "allow" }))).toBe("accepted");
    expect(toolCallState(shell("a", "pending", { requestId: 1 }))).toBe("pending");
  });
});
