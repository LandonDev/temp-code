// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { Block } from "../../lib/session";
import { TranscriptSessionContext } from "../transcriptSession";
import { ActionGroup } from "./ActionGroup";

import { setEditorConfigForTest } from "../../lib/editorConfig";
import { sessionStore } from "../../lib/tcserver/store";
import type { SessionMeta } from "../../lib/tcserver/types";

const agentMeta = (id: string, status: string): SessionMeta =>
  ({ id, parentId: "p", provider: "claude", model: "claude-sonnet-5-5", permission: "edits", title: id, cwd: "/r",
    environmentId: "local", archived: false, status, createdAt: 0 }) as unknown as SessionMeta;

// The agent's thread is titled "A" wherever a call or a report names it.
vi.mock("../../lib/threadMentions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/threadMentions")>()),
  useTitlesOf: () => (id: string) => (id === "a" ? "A" : undefined),
}));

// A row's file menu asks which editor opens files; there is no preload here.
beforeAll(() => setEditorConfigForTest(null));
// Unmount each render, so no scheduled React work outlives the jsdom environment.
afterEach(cleanup);

const CWD = "/r";
const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join("\n");
const tool = (id: string, name: string, input: unknown, extra: Partial<NonNullable<Block["tool"]>> = {}): Block => ({
  id,
  role: "tool",
  text: name,
  tool: { callId: id, name, title: name, status: "completed", input, ...extra },
});
const read = (id: string, path: string) => tool(id, "Read", { file_path: `${CWD}/${path}` }, { kind: "read" });
const bash = (id: string, command: string, extra: Partial<NonNullable<Block["tool"]>> = {}) =>
  tool(id, "Bash", { command }, { kind: "execute", ...extra });
const thought = (id: string): Block => ({ id, role: "reasoning", text: "Weighing the index.", ts: 1, doneTs: 4001 });
const five = (): Block[] => [
  read("a", "src/types.ts"),
  tool("b", "Write", { file_path: `${CWD}/diag.ts`, content: lines(46) }, { kind: "edit" }),
  bash("c", "npx convex dev --once"),
  tool("d", "Edit", { file_path: `${CWD}/schema.ts`, old_string: "x", new_string: lines(3) }, { kind: "edit" }),
  bash("e", "npm test"),
];

let sid = 0;
function mount(blocks: Block[], props: { live?: boolean } = {}, session = `s${++sid}`) {
  return render(
    <TranscriptSessionContext.Provider value={session}>
      <ActionGroup blocks={blocks} cwd={CWD} {...props} />
    </TranscriptSessionContext.Provider>,
  );
}
/** What a row shows, without the accessible name a line with no action keeps in a hidden span. */
const seen = (el: Element): string => {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll(".sr-only").forEach((n) => n.remove());
  return copy.textContent ?? "";
};
/** The group's line, when it shows: a lone call folds it away (kept mounted, hidden). */
const trigger = (c: HTMLElement) => {
  const line = c.querySelector<HTMLButtonElement>("[data-group-line]");
  return line && !line.closest("[hidden]") ? line : null;
};

describe("ActionGroup", () => {
  it("renders a lone call as its own row, no line above it", () => {
    const { container } = mount([read("a", "src/types.ts")]);
    expect(trigger(container)).toBeNull();
    expect(container.textContent).toContain("types.ts");
  });

  it("folds five actions into one closed line with the phrase and the summed counts", () => {
    const { container } = mount(five());
    const line = trigger(container)!;
    expect(line).not.toBeNull();
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(line.textContent).toContain("Read types.ts, created diag.ts, ran convex dev and 2 more");
    expect(line.textContent).toContain("+49");
    expect(line.textContent).toContain("−1");
    expect(container.querySelector("[data-kind]")?.getAttribute("data-kind")).toBe("edit");
  });

  it("leads with the dominant kind's glyph", () => {
    const { container } = mount([read("a", "a.ts"), read("b", "b.ts"), bash("c", "ls")]);
    expect(container.querySelector("[data-kind]")?.getAttribute("data-kind")).toBe("research");
  });

  it("opens on click and stays open across a remount of the same group", () => {
    const blocks = [read("a", "a.ts"), bash("b", "ls")];
    const first = mount(blocks, {}, "keep");
    act(() => {
      fireEvent.click(trigger(first.container)!);
    });
    expect(trigger(first.container)!.getAttribute("aria-expanded")).toBe("true");
    expect(first.container.querySelector("[data-group-rows]")?.children.length).toBe(2);
    first.unmount();
    const again = mount(blocks, {}, "keep");
    expect(trigger(again.container)!.getAttribute("aria-expanded")).toBe("true");
  });

  it("stays closed while live, its phrase in the present tense and still: the working line is the moving one", () => {
    const { container } = mount([read("a", "a.ts"), bash("b", "npm test", { status: "running" })], { live: true });
    expect(trigger(container)!.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("Reading a.ts, running the tests");
    expect(trigger(container)!.querySelector("[data-slot=working-text]")).toBeNull();
    expect(trigger(container)!.querySelector("[data-slot=morph-text]")).not.toBeNull();
  });

  it("is forced open while a step waits on the person", () => {
    const waiting: Block = { ...bash("b", "rm -rf build", { status: "pending" }), approval: { requestId: 1 } };
    const { container } = mount([read("a", "a.ts"), waiting]);
    expect(trigger(container)!.getAttribute("aria-expanded")).toBe("true");
  });

  it("marks failed calls with the failed glyph and their count", () => {
    const { container } = mount([read("a", "a.ts"), bash("b", "npm test", { status: "failed" })]);
    const mark = trigger(container)!.querySelector('[data-slot="status-mark"]')!;
    expect(mark.getAttribute("data-state")).toBe("failed");
    expect(mark.getAttribute("aria-label")).toBe("1 failed");
    expect(mark.textContent).toBe("1");
  });

  it("draws no row for a settled thought: one call and the thought before it is the call's row alone", () => {
    const { container } = mount([thought("t"), read("a", "src/types.ts")]);
    expect(trigger(container)).toBeNull();
    expect(container.querySelector("[data-group-rows]")!.className).not.toContain("pl-5.5");
    expect(container.querySelectorAll("[data-step]")).toHaveLength(1);
    expect(container.textContent).toContain("types.ts");
    expect(container.textContent).not.toContain("Thought");
  });

  it("draws nothing for a run of thoughts alone", () => {
    const { container } = mount([thought("t"), thought("u")]);
    expect(container.innerHTML).toBe("");
  });

  it("shows a thought only in a group opened by hand, as Thought with no duration", () => {
    const { container } = mount([read("a", "a.ts"), thought("t"), bash("b", "ls")]);
    act(() => {
      fireEvent.click(trigger(container)!);
    });
    expect(container.querySelectorAll("[data-step]")).toHaveLength(3);
    expect(container.querySelector("[data-step=t]")?.textContent).toBe("Thought");
    expect(container.textContent).not.toMatch(/Thought for/);
  });

  it("leads the line with the same glyph the run's first read draws on its row", () => {
    const { container } = mount([read("a", "a.ts"), read("b", "b.ts"), bash("c", "ls")]);
    const lineSvg = container.querySelector("[data-kind] svg")!.innerHTML;
    act(() => {
      fireEvent.click(trigger(container)!);
    });
    const rowSvg = container.querySelector("[data-group-rows] [data-glyph] svg")!.innerHTML;
    expect(lineSvg).toBe(rowSvg);
  });

  describe("agent work and the host's steps", () => {
    const orch = (id: string, name: string, input: unknown, extra: Partial<NonNullable<Block["tool"]>> = {}) =>
      tool(id, `mcp__orchestrator__${name}`, input, extra);
    const report = (id: string, status = "done"): Block => ({ id, role: "system", text: "", agent: { id: "a", title: "A", status } });
    const gate = (ok: boolean): Block => ({
      id: `g${ok}`,
      role: "system",
      text: "",
      gate: { step: "gate", branch: "ui-3", ok, log: ok ? "" : "› vitest\ngate failed: vitest", at: 0 },
    });
    const open = (c: HTMLElement) =>
      act(() => {
        fireEvent.click(trigger(c)!);
      });

    const waited = (id: string, detail: unknown) => orch(id, "wait_for_agent", { agentId: "a" }, { detail: JSON.stringify(detail) });

    it("a master's run reads as one line and opens onto its three rows, the report's state marked", () => {
      const { container } = mount([
        orch("s", "spawn_agent", { task: "x" }, { spawned: ["a"] }),
        waited("w", { agentId: "a", status: "idle", reply: "done" }),
        report("r", "error"),
      ]);
      expect(trigger(container)!.textContent).toContain("Spawned “A”, heard from “A”");
      expect(container.querySelector("[data-kind]")?.getAttribute("data-kind")).toBe("agents");
      open(container);
      const list = container.querySelector("[data-group-rows]")!;
      expect(list.children.length).toBe(3);
      expect(seen(list.children[1])).toBe("FinishedA");
      expect(seen(list.children[2])).toBe("FailedA");
      expect(list.children[2].querySelector('[data-slot="status-mark"]')?.getAttribute("data-state")).toBe("failed");
    });

    it("a batch spawn is one Spawned row per child, each by its title with where it stands", async () => {
      sessionStore.injectPush({ push: "session", session: agentMeta("a", "running") }, "local");
      sessionStore.injectPush({ push: "session", session: agentMeta("b", "idle") }, "local");
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      const { container } = mount([
        bash("x", "ls"),
        orch("s", "spawn_agent", { agents: [{ task: "Review only. Do not edit", title: "Review the flow" }, { task: "Audit the gateway\nin depth" }] }, { spawned: ["a", "b"] }),
      ]);
      open(container);
      const lines = [...container.querySelectorAll('[data-block="s"] [class*="group/action"]')];
      expect(lines).toHaveLength(2);
      expect(lines.map((l) => l.querySelector('[data-slot="status-mark"]')?.getAttribute("data-state"))).toEqual(["working", "done"]);
      // The store's title (A) wins; the second child stands on its task's first line until its own lands.
      expect(seen(lines[0])).toBe("SpawnedAWorking");
      expect(seen(lines[1])).toBe("SpawnedAudit the gatewayDone");
      // The row's mark is still: the group's line is the one that moves.
      expect(lines[0].querySelector(".animate-spinner")).toBeNull();
      sessionStore.reset();
    });

    it("a settled wait folds in as Finished <title>, never Waited for or its agent's prompt", () => {
      const { container } = mount([
        bash("x", "ls"),
        orch("s", "spawn_agent", { task: "Review only. Do not edit, commit, push" }, { spawned: ["a"] }),
        waited("w", { agentId: "a", status: "done", reply: "Found two issues." }),
      ]);
      open(container);
      expect(container.textContent).toContain("FinishedA");
      expect(container.textContent).not.toMatch(/Waited|Waiting|Review only/);
    });

    it("an agent the store has not listed is named by what its spawn in the run called it", () => {
      const { container } = mount([
        orch("s", "spawn_agent", { agents: [{ task: "x", title: "Port the board view" }, { task: "Audit the gateway\nin depth" }] }, { spawned: ["z", "y"] }),
        orch("w", "wait_for_agent", { agentIds: ["z", "y"] }, { detail: JSON.stringify([{ agentId: "z", status: "done" }, { agentId: "y", status: "failed" }]) }),
      ]);
      expect(trigger(container)!.textContent).toContain("Spawned 2 agents, heard from 2 agents");
      open(container);
      const steps = [...container.querySelectorAll('[data-block="w"] [class*="group/action"]')].map(seen);
      expect(steps).toEqual(["FinishedPort the board view", "FailedAudit the gateway"]);
    });

    it("a wait that returned on nobody leaves no row", () => {
      const { container } = mount([bash("x", "ls"), waited("w", { status: "steered", message: "hi" }), bash("y", "pwd")]);
      open(container);
      expect(container.querySelector('[data-block="w"]')?.textContent ?? "").toBe("");
    });

    it("every agent row is one 28px line with the title its one bright text", () => {
      const kinds: Block[] = [
        orch("s1", "spawn_agent", { task: "x", title: "Given" }, { spawned: ["a"] }),
        orch("s2", "spawn_agent", { agents: [{ task: "one" }, { task: "two" }] }, { spawned: ["a", "q"] }),
        { id: "old", role: "system", text: "", agent: { id: "q", title: "Older spawn" } },
        report("r", "done"),
        waited("w", { agentId: "a", status: "failed" }),
        orch("m", "send_to_agent", { agentId: "a", message: "go on" }),
        orch("c", "check_agent", { agentId: "a" }),
        orch("an", "answer_agent", { agentId: "a" }),
        orch("i", "interrupt_agent", { agentId: "a" }),
        tool("t", "mcp__app__app_start_thread", { threadType: "planning", title: "Plan the move" }),
      ];
      const { container } = mount(kinds);
      open(container);
      const lines = [...container.querySelectorAll<HTMLElement>('[data-group-rows] [class*="group/action"]')];
      expect(lines.map(seen)).toEqual([
        "SpawnedA",
        "SpawnedA",
        "Spawnedtwo",
        "SpawnedOlder spawn",
        "FinishedA",
        "FailedA",
        "MessagedA",
        "CheckedA",
        "AnsweredA",
        "StoppedA",
        "New planning threadPlan the move",
      ]);
      for (const line of lines) {
        expect(line.className, line.textContent ?? "").toContain("h-7");
        // No wrapper of the row adds space of its own.
        for (let el = line.parentElement; el && !el.hasAttribute("data-group-rows"); el = el.parentElement) {
          expect(el.className, line.textContent ?? "").not.toMatch(/(^|\s)-?[mp][trblxy]?-/);
        }
        // The bright text: foreground text outside the state's own mark, innermost (a link wraps
        // its text; the line's own button is an empty layer under the words).
        const bright = [...line.querySelectorAll(".text-foreground")].filter(
          (el) => !!el.textContent?.trim() && !el.closest('[data-slot="status-mark"]') && !el.querySelector(".text-foreground"),
        );
        expect(bright.map((el) => el.textContent), line.textContent ?? "").toHaveLength(1);
        expect(["A", "two", "Older spawn", "Plan the move"]).toContain(bright[0].textContent);
        expect(line.querySelector(".text-muted-foreground")).not.toBeNull();
      }
    });

    it("a red gate counts on the line's figure and opens its log in place", () => {
      const { container } = mount([bash("b", "ls"), gate(false)]);
      const mark = trigger(container)!.querySelector('[data-slot="status-mark"]')!;
      expect(mark.textContent).toBe("1");
      open(container);
      const logTrigger = container.querySelector<HTMLButtonElement>('[data-group-rows] [data-slot="collapsible-trigger"]')!;
      act(() => {
        fireEvent.click(logTrigger);
      });
      expect(container.querySelector("[data-group-rows] pre")?.textContent).toContain("gate failed: vitest");
    });

    it("a todo update folds as a step, Updated todos 3/7, and opens its list", () => {
      const todos = Array.from({ length: 7 }, (_, i) => ({ content: `step ${i}`, status: i < 3 ? "completed" : "pending" }));
      const { container } = mount([bash("b", "ls"), tool("t", "TodoWrite", { todos })]);
      expect(trigger(container)!.textContent).toContain("updated todos");
      open(container);
      const row = container.querySelector("[data-group-rows]")!.children[1] as HTMLElement;
      expect(row.textContent).toContain("Updated todos");
      expect(row.textContent).toContain("3/7");
      act(() => {
        fireEvent.click(row.querySelector("button")!);
      });
      expect(row.textContent).toContain("step 6");
    });

    it("a lone report is its own line with no group", () => {
      const { container } = mount([report("r")]);
      expect(trigger(container)).toBeNull();
      expect(container.textContent).toContain("Heard from");
      expect(container.textContent).toContain("A");
    });
  });

  it("never puts content-visibility or containment on the group", () => {
    const { container } = mount(five());
    act(() => {
      fireEvent.click(trigger(container)!);
    });
    for (const el of container.querySelectorAll<HTMLElement>("*")) {
      expect(el.style.contentVisibility).toBeFalsy();
      expect(el.style.contain).toBeFalsy();
      expect(el.className.toString()).not.toMatch(/content-visibility|contain-/);
    }
  });
});
