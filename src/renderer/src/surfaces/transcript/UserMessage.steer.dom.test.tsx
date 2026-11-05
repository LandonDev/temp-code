// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import type { Block, SteerStamp } from "../../lib/session";
import { clockTime } from "../../lib/duration";
import { steerTip, steerWord } from "../../lib/steerWords";

// The tooltip's label inline, so the test reads what it would say.
vi.mock("../../components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: el, children }: { render?: ReactElement; children: ReactNode }) =>
    el ? cloneElement(el, {}, children) : <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span data-tip="">{children}</span>,
}));

const { UserMessageBlock } = await import("./UserMessage");

const at = new Date(2026, 10, 1, 14, 2).getTime();
// The app's one clock (lib/duration.ts), by this machine's locale.
const t = clockTime(at);
const user = (steer?: SteerStamp): Block => ({ id: "u", role: "user", text: "use the other table", steerId: "s1", ...(steer ? { steer } : {}) });
const mount = (block: Block) => render(<UserMessageBlock block={block} stickyIndex={1} environmentId="local" />);
const line = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-steer]");
const word = (c: HTMLElement) => line(c)!.querySelector("span:not([data-tip])")!;
const tip = (c: HTMLElement) => line(c)!.querySelector("[data-tip]")!.textContent;

afterEach(cleanup);

describe("a steer's line under its bubble", () => {
  it("says each state in one word, the time and how in its tooltip", () => {
    const cases: [SteerStamp, string, string][] = [
      [{ state: "sent", ts: at }, "Sent", `Sent at ${t}`],
      [{ state: "received", how: "in-turn", ts: at }, "Received", `Received at ${t}`],
      [{ state: "received", how: "next-turn", ts: at }, "Received", `Received at ${t}, as its own turn`],
      [{ state: "queued", ts: at }, "Queued for the next turn", `Queued at ${t}`],
      [{ state: "failed", reason: "the harness did not start", ts: at }, "Not delivered", "Not delivered: the harness did not start"],
    ];
    for (const [stamp, w, t] of cases) {
      const { container, unmount } = mount(user(stamp));
      expect(word(container).textContent).toBe(w);
      expect(tip(container)).toBe(t);
      expect(word(container).className).toContain(stamp.state === "failed" ? "text-destructive" : "text-muted-foreground");
      expect(word(container).className).toContain("text-xs");
      expect(steerWord(stamp)).toBe(w);
      expect(steerTip(stamp)).toBe(t);
      unmount();
    }
  });

  it("draws nothing for a message with no stamp", () => {
    const { container } = mount(user());
    expect(line(container)).toBeNull();
  });

  it("keeps one line box from Sent to Received, fading only the word that changed on screen", () => {
    const { container, rerender } = mount(user({ state: "sent", ts: at }));
    const box = line(container)!;
    expect(box.className).toContain("h-4");
    expect(box.parentElement!.lastElementChild).toBe(box);
    expect(word(container).className).not.toContain("z-fade-in");
    rerender(<UserMessageBlock block={user({ state: "received", how: "in-turn", ts: at + 1 })} stickyIndex={1} environmentId="local" />);
    expect(line(container)).toBe(box);
    expect(box.className).toContain("h-4");
    expect(word(container).textContent).toBe("Received");
    expect(word(container).className).toContain("z-fade-in");
  });
});
