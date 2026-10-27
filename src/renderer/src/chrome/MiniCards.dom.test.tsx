// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The composer's mini cards are Attachments: a glyph, a title and one
 * description, Remove at the end; the inbox card opens its item and
 * carries no label chips; an embedded note has no wrapper or description.
 */

const h = vi.hoisted(() => ({ openUrl: vi.fn() }));
vi.mock("../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/native")>()),
  openUrl: (...args: unknown[]) => h.openUrl(...args),
}));
vi.mock("./HarnessIcon", () => ({ HarnessIcon: () => <span data-icon="harness" /> }));

import { InboxMiniCard } from "./InboxMiniCard";
import { NoteMiniCard } from "./NoteMiniCard";
import { HandoffMiniCard } from "./HandoffMiniCard";

afterEach(() => {
  cleanup();
  h.openUrl.mockReset();
});

const descriptions = (el: HTMLElement) => el.querySelectorAll('[data-slot="attachment-description"]');
const titleOf = (el: HTMLElement) => el.querySelector('[data-slot="attachment-title"]')?.textContent;

describe("the composer's mini cards", () => {
  it("the inbox card says title, ref and repo, opens its item and has no label chips", () => {
    const onDismiss = vi.fn();
    const view = render(
      <InboxMiniCard
        card={{
          provider: "github",
          kind: "pr",
          identifier: "#12",
          title: "Fix the gate",
          url: "https://github.com/me/app/pull/12",
          source: "me/app",
          labels: [{ name: "bug", color: "d73a4a" }],
          prompt: "",
        }}
        onDismiss={onDismiss}
      />,
    );
    expect(view.container.querySelector('[data-slot="attachment"]')).not.toBeNull();
    expect(titleOf(view.container)).toBe("Fix the gate");
    expect(descriptions(view.container)).toHaveLength(1);
    expect(descriptions(view.container)[0].textContent).toBe("#12me/app");
    expect(view.container.textContent).not.toContain("bug");
    expect(view.container.textContent).not.toContain("Pull request");
    fireEvent.click(view.getByRole("button", { name: "Open Pull request #12 in GitHub" }));
    expect(h.openUrl).toHaveBeenCalledWith("https://github.com/me/app/pull/12");
    fireEvent.click(view.getByRole("button", { name: "Remove Pull request #12" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("the note card names its project; embedded it has no wrapper and no description", () => {
    const onDismiss = vi.fn();
    const card = { title: "Gateway notes", slug: "gateway", sourceCwd: "/srv/work/app" } as never;
    const view = render(<NoteMiniCard card={card} onDismiss={onDismiss} />);
    expect(titleOf(view.container)).toBe("Gateway notes");
    expect(descriptions(view.container)).toHaveLength(1);
    expect(view.container.firstElementChild?.getAttribute("data-slot")).not.toBe("attachment");
    fireEvent.click(view.getByRole("button", { name: "Remove note Gateway notes" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    cleanup();
    const embedded = render(<NoteMiniCard card={card} embedded />);
    expect(embedded.container.firstElementChild?.getAttribute("data-slot")).toBe("attachment");
    expect(descriptions(embedded.container)).toHaveLength(0);
    expect(embedded.queryByRole("button")).toBeNull();
  });

  it("the handoff card says from and to, then the request and the files", () => {
    const onDismiss = vi.fn();
    const view = render(
      <HandoffMiniCard card={{ from: "claude", to: "codex", request: "Finish the port", files: 3 }} onDismiss={onDismiss} />,
    );
    expect(titleOf(view.container)).toContain("Claude");
    expect(descriptions(view.container)).toHaveLength(1);
    expect(descriptions(view.container)[0].textContent).toBe("Finish the port3 files");
    fireEvent.click(view.getByRole("button", { name: "Remove handoff" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
