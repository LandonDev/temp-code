// A8 (action rows): one of each row, for a static look at the standard.
import type { ComponentProps } from "react";
import type { Block } from "../../lib/session";
import type { ActivityRow } from "./ActivityRow";

const CWD = "/repo";

function call(
  id: string,
  name: string,
  input: unknown,
  extra: Partial<NonNullable<Block["tool"]>> & Partial<Pick<Block, "approval" | "streaming">> = {},
): Block {
  const { approval, streaming, ...tool } = extra;
  return {
    id,
    role: "tool",
    text: name,
    streaming: streaming ?? false,
    ...(approval ? { approval } : {}),
    tool: { callId: id, title: name, status: "completed", name, input, ...tool },
  };
}

const testOutput = ["", " ✓ src/lib/paths.test.ts (12 tests) 9ms", " ✓ src/lib/toolPhrase.test.ts (22 tests) 11ms", "", " Test Files  2 passed (2)", "      Tests  34 passed (34)"].join("\n");

/** Every row the transcript draws for an action, in `ActivityRow`'s props. */
export const ACTION_FIXTURES: { name: string; open?: boolean; props: ComponentProps<typeof ActivityRow> }[] = [
  {
    name: "An edit, +46 −3",
    props: {
      cwd: CWD,
      block: call("e1", "Edit", {
        file_path: "/repo/src/lib/paths.ts",
        old_string: "a\nb\nc",
        new_string: Array.from({ length: 46 }, (_, n) => `line ${n}`).join("\n"),
      }),
    },
  },
  {
    name: "A created file",
    props: { cwd: CWD, block: call("e2", "Write", { file_path: "/repo/diag.ts", content: "export const x = 1;\nexport const y = 2;" }) },
  },
  {
    name: "A deleted file",
    props: {
      cwd: CWD,
      block: {
        id: "e3",
        role: "tool",
        text: "Deleted old.ts",
        tool: { callId: "e3", kind: "delete", title: "Deleted old.ts", status: "completed", preview: { kind: "write", path: "/repo/src/old.ts", deletions: 12 } },
      },
    },
  },
  {
    name: "A running edit",
    props: {
      cwd: CWD,
      live: true,
      block: call("e4", "Edit", { file_path: "/repo/src/App.tsx", old_string: "x", new_string: "y\nz" }, { status: "running", streaming: true }),
    },
  },
  { name: "A run, closed", props: { cwd: CWD, block: call("r1", "Bash", { command: "npx vitest run src/lib" }, { detail: testOutput }) } },
  {
    name: "A run, open with output",
    open: true,
    props: {
      cwd: CWD,
      block: call("r2", "Bash", { command: "cd /repo && NODE_ENV=test npx vitest run src/lib 2>&1 | tail -20", description: "Run the lib tests" }, { detail: testOutput }),
    },
  },
  {
    name: "A failed run, open",
    open: true,
    props: {
      cwd: CWD,
      block: call("r3", "Bash", { command: "bun run typecheck" }, { status: "failed", detail: "src/a.ts(3,1): error TS2304: Cannot find name 'x'." }),
    },
  },
  { name: "A read", props: { cwd: CWD, block: call("d1", "Read", { file_path: "/repo/src/types.ts", offset: 120 }) } },
  {
    name: "A search, open",
    open: true,
    props: { cwd: CWD, block: call("s1", "Grep", { pattern: "toolCallLabel", path: "src" }, { detail: "src/a.ts:12\nsrc/b.ts:40" }) },
  },
  {
    name: "A connector call with Reconnect",
    props: {
      cwd: CWD,
      block: call(
        "m1",
        "mcp__linear__save_issue",
        {},
        { status: "failed", display: { app: "linear", action: "Save issue" }, reauth: { app: "linear", url: "https://linear.app" } },
      ),
    },
  },
  { name: "An app call naming a thread", props: { cwd: CWD, block: call("a1", "mcp__app__app_read_thread", { threadId: "t1" }) } },
  {
    name: "A call waiting on approval",
    props: {
      cwd: CWD,
      block: {
        ...call("p1", "Bash", { command: "git push origin master", description: "Push master" }, { status: "pending" }),
        role: "approval",
        approval: { requestId: 1 },
      },
    },
  },
];
