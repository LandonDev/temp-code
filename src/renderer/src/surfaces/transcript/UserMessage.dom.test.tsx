// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { Block } from "../../lib/session";
import { UserMessageBlock } from "./UserMessage";

const user = (extra: Partial<Block> = {}): Block => ({ id: "u", role: "user", text: "Fix the build", ts: 1_700_000_000_000, ...extra });
const mount = (block: Block) => render(<UserMessageBlock block={block} stickyIndex={1} environmentId="local" />);
const bubble = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-user-bubble]")!;

const realScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
afterEach(() => {
  cleanup();
  if (realScrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", realScrollHeight);
  else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
});

describe("UserMessageBlock", () => {
  it("sits on the right with the words and no time", () => {
    const { container } = mount(user());
    const row = container.firstElementChild as HTMLElement;
    expect(row.className).toContain("items-end");
    expect(bubble(container).textContent).toBe("Fix the build");
    expect(container.textContent).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("is the prose's 14px on 22px lines, 12/8 inside a 12px corner, at most 85% of the column", () => {
    const { container } = mount(user());
    const cls = bubble(container).className;
    for (const c of ["text-sm", "leading-[22px]", "px-3", "py-2", "rounded-xl", "max-w-[85%]"]) expect(cls).toContain(c);
    // The row has no margin of its own: the transcript's gap is above it.
    expect((container.firstElementChild as HTMLElement).className).not.toMatch(/(?:^|\s)(?:p[tbl]|m[tb])-\d/);
  });

  it("folds the project rules above the bubble, not inside it", () => {
    const { container } = mount(user({ preamble: { text: "Work in a worktree.", words: 4 } }));
    const preamble = container.querySelector("[data-preamble-row]")!;
    expect(preamble).not.toBeNull();
    expect(bubble(container).contains(preamble)).toBe(false);
    expect(preamble.compareDocumentPosition(bubble(container)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 4px above the bubble.
    expect(preamble.className).toContain("mb-1");
  });

  it("draws a second opinion as one notice line on the left, not a bubble", () => {
    const { container } = mount(user({ text: "", secondOpinion: { from: "claude", to: "codex", files: 3 } }));
    expect(container.querySelector("[data-user-bubble]")).toBeNull();
    const line = container.querySelector('[data-slot="notice-line"]')!;
    expect(line.textContent).toBe("Second opinionCodex, 3 files");
    expect(container.textContent).not.toContain("Claude");
  });

  it("keeps a handoff's brief in its bubble", () => {
    const { container } = mount(user({ text: "Carry on from here", secondOpinion: { from: "claude", to: "codex", kind: "handoff" } }));
    expect(bubble(container).textContent).toContain("Handoff");
    expect(bubble(container).textContent).toContain("Carry on from here");
    expect(container.querySelector('[data-slot="notice-line"]')).toBeNull();
  });

  it("keeps attachments inside the bubble", () => {
    const { container } = mount(
      user({ attachments: [{ id: "f", name: "log.txt", mimeType: "text/plain", kind: "file", size: 10 }] }),
    );
    expect(bubble(container).textContent).toContain("log.txt");
  });

  it("shows a message whole up to twelve lines, then Show more and Show less", () => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 400 });
    const { container, getByRole } = mount(user({ text: "line\n".repeat(30) }));
    const pre = bubble(container).querySelector("pre")!;
    expect(pre.className).toContain("line-clamp-12");
    act(() => {
      fireEvent.click(getByRole("button", { name: "Show more" }));
    });
    expect(pre.className).not.toContain("line-clamp-12");
    act(() => {
      fireEvent.click(getByRole("button", { name: "Show less" }));
    });
    expect(pre.className).toContain("line-clamp-12");
  });

  it("Show more is a 24px target whose words keep their place", () => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 400 });
    const { getByRole } = mount(user({ text: "line\n".repeat(30) }));
    const cls = getByRole("button", { name: "Show more" }).className.split(" ");
    for (const c of ["h-6", "mt-0.5", "-mb-0.5"]) expect(cls).toContain(c);
    expect(cls).not.toContain("h-auto");
  });

  it("sets attachments 8px apart, on the grid", () => {
    const { container } = mount(
      user({
        attachments: [
          { id: "f", name: "log.txt", mimeType: "text/plain", kind: "file", size: 10 },
          { id: "g", name: "trace.txt", mimeType: "text/plain", kind: "file", size: 12 },
        ],
      }),
    );
    const row = bubble(container).querySelector("pre")!.previousElementSibling as HTMLElement;
    expect(row.className.split(" ")).toContain("gap-2");
  });

  it("the project rules line ends on the bubble's edge, its chevron trailing", () => {
    const { container } = mount(user({ preamble: { text: "Work in a worktree.", words: 4 } }));
    const trigger = container.querySelector<HTMLElement>("[data-preamble-row] > button")!;
    const cls = trigger.className.split(" ");
    expect(cls).toContain("-mr-2");
    expect(cls).toContain("self-end");
    expect(cls).not.toContain("-ml-2");
    expect(trigger.lastElementChild?.tagName.toLowerCase()).toBe("svg");
  });

  it("offers no Show more for a message that fits", () => {
    const { queryByRole } = mount(user());
    expect(queryByRole("button", { name: "Show more" })).toBeNull();
  });

});
