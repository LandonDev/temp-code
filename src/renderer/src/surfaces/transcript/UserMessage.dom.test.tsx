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

  it("folds the project rules above the bubble, not inside it", () => {
    const { container } = mount(user({ preamble: { text: "Work in a worktree.", words: 4 } }));
    const preamble = container.querySelector("[data-preamble-row]")!;
    expect(preamble).not.toBeNull();
    expect(bubble(container).contains(preamble)).toBe(false);
    expect(preamble.compareDocumentPosition(bubble(container)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it("offers no Show more for a message that fits", () => {
    const { queryByRole } = mount(user());
    expect(queryByRole("button", { name: "Show more" })).toBeNull();
  });

});
