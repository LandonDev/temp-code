// @vitest-environment jsdom
/**
 * The live turn's one working line (TurnLine, drawn by TurnEnd): what it
 * says phase by phase, the call it tells, the body it opens, when it hides,
 * and the settle into the closing line in the same element.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FOLD_HOLD_MS } from "../../lib/ease";
import { setEditorConfigForTest } from "../../lib/editorConfig";
import type { Block } from "../../lib/session";
import type { TurnInfo } from "../transcriptRows";
import { TranscriptSessionContext } from "../transcriptSession";
import { TurnStateContext, type TurnSession } from "../turnState";
import { ActionGroup } from "./ActionGroup";
import { TurnEnd } from "./TurnEnd";
import { openedLive, setOpenedLive } from "./workingOpen";
import { revealDrainForTest } from "../revealDrain";

beforeAll(() => setEditorConfigForTest(null));
beforeEach(() => {
  // Let Motion finish every exit at once, on jsdom's own frames (real time).
  MotionGlobalConfig.skipAnimations = true;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  MotionGlobalConfig.skipAnimations = false;
});

const CWD = "/r";
const pending: Block = { id: "pending:1", role: "user", text: "go", pending: true };
const user: Block = { id: "u", role: "user", text: "go" };
const tool = (id: string, name: string, kind: string, input: unknown, status = "running"): Block => ({
  id,
  role: "tool",
  text: name,
  tool: { callId: id, name, kind, title: name, status, input },
});
const read = (id: string, status = "running") => tool(id, "Read", "read", { file_path: `${CWD}/src/format.ts` }, status);
const bash = (id: string, status = "running") => tool(id, "Bash", "execute", { command: "npm test" }, status);

const turnOf = (blocks: Block[], over: Partial<TurnInfo> = {}): TurnInfo => ({
  id: "t",
  index: 0,
  isLast: true,
  settled: false,
  blocks,
  userBlock: blocks[0],
  durationMs: undefined,
  startedAt: undefined,
  ...over,
});
const end = (blocks: Block[], activity?: string, over: Partial<TurnInfo> = {}, status = "running") => {
  const state = { status, busy: status === "running", blocks, activity } as unknown as TurnSession;
  return (
    <TranscriptSessionContext.Provider value="s1">
      <TurnStateContext.Provider value={state}>
        <TurnEnd turn={turnOf(blocks, over)} cwd={CWD} harnessOf={() => undefined} turnState={state} liveState={false} />
      </TurnStateContext.Provider>
    </TranscriptSessionContext.Provider>
  );
};
const status = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-slot="turn-line"] [role="status"]');
const label = (c: HTMLElement) => status(c)?.getAttribute("aria-label");
const mark = (c: HTMLElement) => c.querySelector('[data-slot="working-mark"]');
const lineEl = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-slot="turn-line"]');
const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
/** Let Motion's frames run: an exit ends, a count ticks home. */
const flush = () => wait(400);
/** A phase holds 300 ms, then the old words leave and the new arrive. */
const hold = () => wait(400);

describe("the working line", () => {
  it("says each phase in turn: Sending, the host's words, Thinking with its sentence, the call, the mark alone under prose", async () => {
    const view = render(end([pending], "Starting the CLI"));
    expect(label(view.container)).toBe("Sending");
    expect(mark(view.container)).not.toBeNull();

    view.rerender(end([user], "Starting the CLI"));
    await hold();
    expect(label(view.container)).toBe("Starting the CLI");

    view.rerender(end([user, { id: "r", role: "reasoning", text: "I read it. Now the tests.", streaming: true }]));
    await hold();
    expect(label(view.container)).toBe("Thinking");
    expect(status(view.container)?.textContent).toContain("Now the tests.");

    view.rerender(end([user, read("c1")]));
    await hold();
    expect(label(view.container)).toBe("Reading format.ts");
    // Its verb muted, its object in foreground, inside the shimmer.
    expect(view.container.querySelector('[data-slot="working-text"] .text-foreground')?.textContent).toBe("format.ts");

    view.rerender(end([user, read("c1", "completed"), { id: "p", role: "assistant", text: "Here is", streaming: true }]));
    await hold();
    expect(label(view.container)).toBe("Working");
    expect(mark(view.container)).not.toBeNull();
    expect(view.container.querySelector('[data-slot="working-text"]')).toBeNull();
  });

  it("is one 28px line at the prose edge, its words 22px in past the mark's slot", () => {
    const { container } = render(end([user]));
    const line = status(container)!;
    expect(line.className).toContain("h-7");
    expect(line.className).toContain("text-[13px]");
    expect(container.querySelector("[data-turn-words]")!.className).toContain("pl-5.5");
  });

  it("ticks one running edit's counts after its words", async () => {
    const edit = tool("e1", "Edit", "edit", { file_path: `${CWD}/a.ts`, old_string: "x", new_string: "a\nb\nc" });
    const { container } = render(end([user, edit]));
    await flush();
    expect(label(container)).toBe("Editing a.ts");
    expect(container.querySelector('[data-slot="counts"]')?.textContent).toContain("+3");
  });

  it("opens one running command's body under the line from its chevron, and remembers it", () => {
    const { container } = render(end([user, bash("b1")]));
    const button = container.querySelector<HTMLButtonElement>('[data-slot="turn-line"] button[aria-expanded]')!;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    act(() => {
      fireEvent.click(button);
    });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-slot="turn-line"] [data-row-body]')).not.toBeNull();
    expect(openedLive("b1")).toBe(true);
  });

  it("the opened body starts at the glyph edge, as the settled row's does", () => {
    const { container } = render(end([user, bash("b9")]));
    act(() => {
      fireEvent.click(container.querySelector<HTMLButtonElement>('[data-slot="turn-line"] button[aria-expanded]')!);
    });
    const body = container.querySelector<HTMLElement>('[data-slot="turn-line"] [data-row-body]')!;
    // Its wrapper carries the row's bottom space and no inset: ActionRow's is `pb-2`, from the glyph.
    const wrapper = body.parentElement!;
    expect(wrapper.className.split(" ")).toContain("pb-2");
    expect(wrapper.className).not.toMatch(/\bp[lsx]-/);
  });

  it("lands a call opened from the line open in its group, which counts as the person's hand", () => {
    vi.useFakeTimers();
    setOpenedLive("c1", true);
    const group = (blocks: Block[], working: boolean) => (
      <TranscriptSessionContext.Provider value="hand">
        <ActionGroup blocks={blocks} cwd={CWD} live={working} working={working} settled={!working} />
      </TranscriptSessionContext.Provider>
    );
    const view = render(group([bash("c0", "completed"), bash("c1")], true));
    expect(view.container.querySelector("[data-step=c1]")).toBeNull();
    view.rerender(group([bash("c0", "completed"), bash("c1", "completed")], false));
    expect(view.container.querySelector("[data-step=c1] [data-row-body]")).not.toBeNull();
    act(() => vi.advanceTimersByTime(FOLD_HOLD_MS * 2));
    expect(view.container.querySelector("[data-group-line]")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("hides while a step waits on the person, while the turn is paused, and after a Stop", () => {
    const asking: Block = { ...bash("b1", "pending"), approval: { requestId: 1 } };
    expect(render(end([user, asking])).container.querySelector('[data-slot="turn-line"]')).toBeNull();
    cleanup();
    expect(render(end([user], undefined, {}, "paused")).container.querySelector('[data-slot="turn-line"]')).toBeNull();
    cleanup();
    const stop: Block = { id: "err", role: "system", text: "Stopped", stopped: true };
    expect(render(end([user, stop])).container.querySelector('[data-slot="turn-line"]')).toBeNull();
  });

  it("becomes the closing line in the same element when the turn settles, the mark gone", async () => {
    const blocks = [{ ...user, startedAt: 10 }, { id: "a", role: "assistant", text: "Done." } as Block];
    const view = render(end(blocks));
    const line = view.container.querySelector('[data-slot="turn-line"]');
    expect(mark(view.container)).not.toBeNull();
    view.rerender(end(blocks, undefined, { settled: true, durationMs: 124_000 }, "idle"));
    await flush();
    expect(view.container.querySelector('[data-slot="turn-line"]')).toBe(line);
    expect(mark(view.container)).toBeNull();
    expect(line?.textContent).toBe("Worked for 2m 4s");
    expect(view.container.querySelector("[data-turn-words]")!.className).not.toContain("pl-5.5");
  });

  it("draws the closing line at once, with no mark, when it mounts settled", () => {
    const blocks = [user, { id: "a", role: "assistant", text: "Done." } as Block];
    const { container } = render(end(blocks, undefined, { settled: true, durationMs: 2_000 }, "idle"));
    expect(mark(container)).toBeNull();
    expect(status(container)).toBeNull();
    expect(container.querySelector('[data-slot="turn-line"]')?.textContent).toBe("Worked for 2s");
  });
});

describe("the thinking line", () => {
  const thought = (text: string): Block => ({ id: "r", role: "reasoning", text, streaming: true });
  const words = (c: HTMLElement) => status(c)?.querySelector('[data-turn-words]')?.textContent;
  const morphs = (c: HTMLElement) => c.querySelectorAll('[data-slot="turn-line"] [data-morph-key]').length;

  it("draws the thought's sentence in place of Thinking, in the same line, said as Thinking throughout", async () => {
    const view = render(end([user, thought("")]));
    const line = view.container.querySelector('[data-slot="turn-line"]');
    expect(words(view.container)).toBe("Thinking");
    expect(label(view.container)).toBe("Thinking");

    view.rerender(end([user, thought("I read the schema.")]));
    await hold();
    await flush();
    expect(words(view.container)).toBe("I read the schema.");
    expect(status(view.container)?.textContent).not.toContain("Thinking");
    expect(label(view.container)).toBe("Thinking");
    expect(view.container.querySelector('[data-slot="turn-line"]')).toBe(line);
    // The sentence shimmers as the words do.
    expect(view.container.querySelector('[data-slot="working-text"]')?.textContent).toBe("I read the schema.");
  });

  it("skips a sentence that came and went inside the hold, and never draws two at once", async () => {
    const view = render(end([user, thought("")]));
    view.rerender(end([user, thought("First one.")]));
    await wait(100);
    view.rerender(end([user, thought("First one. Second one.")]));
    expect(words(view.container)).toBe("Thinking");
    await hold();
    await flush();
    expect(words(view.container)).toBe("Second one.");
    expect(morphs(view.container)).toBe(1);
    expect(label(view.container)).toBe("Thinking");
  });

  it("redraws a sentence growing under its key in place, with no morph", async () => {
    const view = render(end([user, thought("I read")]));
    expect(words(view.container)).toBe("I read");
    const span = view.container.querySelector('[data-slot="turn-line"] [data-morph-key]');
    view.rerender(end([user, thought("I read the file")]));
    expect(words(view.container)).toBe("I read the file");
    expect(view.container.querySelector('[data-slot="turn-line"] [data-morph-key]')).toBe(span);
  });
});

describe("the line never unmounts once live: transitions, not cuts", () => {
  const content = (c: HTMLElement) => lineEl(c)?.querySelector<HTMLElement>(":scope > [data-slot=collapsible-content], :scope > div");

  it("folds away while a card waits or the turn is paused, and comes back in the same element", () => {
    const view = render(end([user, bash("b1")]));
    const line = lineEl(view.container);
    expect(status(view.container)).not.toBeNull();
    const asking: Block = { ...bash("b1", "pending"), approval: { requestId: 1 } };
    view.rerender(end([user, asking]));
    expect(lineEl(view.container)).toBe(line);
    // Folded: no live status, its words kept as they were under the fold.
    expect(status(view.container)).toBeNull();
    expect(content(view.container)?.className).toContain("collapsible-auto");
    expect(line?.textContent).toContain("Running");
    view.rerender(end([user, bash("b1")], undefined, {}, "paused"));
    expect(lineEl(view.container)).toBe(line);
    expect(status(view.container)).toBeNull();
    view.rerender(end([user, bash("b1")]));
    expect(lineEl(view.container)).toBe(line);
    expect(status(view.container)).not.toBeNull();
    expect(mark(view.container)).not.toBeNull();
  });

  it("says Worked when the turn is over before its duration lands, and the time fills in under the same words", async () => {
    const blocks = [{ ...user, startedAt: 10 }, { id: "a", role: "assistant", text: "Done." } as Block];
    const view = render(end(blocks));
    const line = lineEl(view.container);
    view.rerender(end(blocks, undefined, { settled: true }, "idle"));
    await flush();
    expect(lineEl(view.container)).toBe(line);
    expect(line?.textContent).toBe("Worked");
    const closed = line!.querySelector('[data-morph-key="closed"]');
    expect(closed).not.toBeNull();
    view.rerender(end(blocks, undefined, { settled: true, durationMs: 124_000 }, "idle"));
    expect(line?.textContent).toBe("Worked for 2m 4s");
    // The same words' element: no second morph.
    expect(line!.querySelector('[data-morph-key="closed"]')).toBe(closed);
  });

  it("draws nothing for a turn over before it was ever live here, until its duration lands", () => {
    const blocks = [user, { id: "a", role: "assistant", text: "Done." } as Block];
    const { container } = render(end(blocks, undefined, { settled: true }, "idle"));
    expect(lineEl(container)).toBeNull();
  });

  it("keeps a call's counts and chevron inside its words, so they leave with them", () => {
    const { container } = render(end([user, bash("b1")]));
    const words = container.querySelector('[data-morph-key^="call:"]')!;
    expect(words).not.toBeNull();
    expect(words.querySelector("svg")).not.toBeNull();
  });
});

describe("the closing line waits for the reveal to drain", () => {
  afterEach(() => revealDrainForTest.reset());

  it("keeps the mark while a row of the turn still reveals, then morphs into Worked for", async () => {
    const blocks = [{ ...user, startedAt: 10 }, { id: "a", role: "assistant", text: "A burst that landed whole." } as Block];
    const view = render(end(blocks));
    const line = lineEl(view.container);
    // The burst is still revealing when the host settles the turn 30 ms later.
    act(() => revealDrainForTest.report("t", "row-a", true));
    view.rerender(end(blocks, undefined, { settled: true, durationMs: 2_000 }, "idle"));
    await flush();
    expect(lineEl(view.container)).toBe(line);
    expect(mark(view.container)).not.toBeNull();
    expect(line?.textContent).not.toMatch(/Worked/);
    act(() => revealDrainForTest.report("t", "row-a", false));
    await flush();
    expect(lineEl(view.container)).toBe(line);
    expect(mark(view.container)).toBeNull();
    expect(line?.textContent).toBe("Worked for 2s");
  });
});

