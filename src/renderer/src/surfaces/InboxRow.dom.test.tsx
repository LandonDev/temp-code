// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The inbox row: two lines, one glyph, the title's weight says unseen, a
 * status only for failed checks, the host's glyph with two hosts, and no
 * provider mark, labels or avatars (the detail pane has them).
 */

const h = vi.hoisted(() => ({
  unseen: false,
  environments: [
    { id: "local", name: "This Mac" },
    { id: "env_box", name: "The box", platform: "linux" },
  ] as { id: string; name: string; platform?: string }[],
}));

vi.mock("../lib/inboxSeen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/inboxSeen")>()),
  isInboxEntryUnseen: () => h.unseen,
}));
vi.mock("../lib/connection/status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/connection/status")>()),
  useEnvironments: () => h.environments,
}));

import { InboxRow } from "./InboxView";

const pr = (over: Record<string, unknown> = {}) =>
  ({
    kind: "pr",
    number: 7,
    title: "Fix the gate",
    url: "https://github.com/me/app/pull/7",
    state: "open",
    updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    labels: [{ name: "bug", color: "ff0000" }],
    assignees: [],
    draft: false,
    repo: "me/app",
    projectPath: "/srv/repo",
    provider: "github",
    author: { login: "ana", avatarUrl: "https://example.com/a.png" },
    environmentId: "env_box",
    ...over,
  }) as never;

afterEach(() => {
  cleanup();
  h.unseen = false;
});

const title = (el: HTMLElement) => el.querySelector("[data-row-title]") as HTMLElement;

describe("InboxRow", () => {
  it("sets an unseen title in medium and says new in its label; a seen one is normal", () => {
    h.unseen = true;
    const unseen = render(<InboxRow item={pr()} active={false} environmentId="env_box" showSource={false} onSelect={() => {}} />);
    expect(title(unseen.container).className).toContain("font-medium");
    expect(unseen.getByRole("button").getAttribute("aria-label")).toBe("Fix the gate, new");
    cleanup();
    h.unseen = false;
    const seen = render(<InboxRow item={pr()} active={false} environmentId="env_box" showSource={false} onSelect={() => {}} />);
    expect(title(seen.container).className).toContain("font-normal");
    expect(seen.getByRole("button").getAttribute("aria-label")).toBeNull();
  });

  it("marks failed checks with the status mark and approved with nothing", () => {
    const failed = render(<InboxRow item={pr({ checks: "FAILURE" })} active={false} showSource={false} onSelect={() => {}} />);
    const mark = failed.container.querySelector('[data-slot="status-mark"]');
    expect(mark?.getAttribute("data-state")).toBe("failed");
    expect(failed.container.textContent).toContain("Failedchecks");
    cleanup();
    const approved = render(<InboxRow item={pr({ reviewDecision: "APPROVED" })} active={false} showSource={false} onSelect={() => {}} />);
    expect(approved.container.querySelector('[data-slot="status-mark"]')).toBeNull();
    expect(approved.container.textContent).not.toContain("Approved");
  });

  it("draws one glyph, no provider mark, labels or avatar, and no dots between facts", () => {
    const row = render(<InboxRow item={pr()} active showSource onSelect={() => {}} />);
    const text = row.container.textContent ?? "";
    expect(text).toContain("#7");
    expect(text).toContain("me/app");
    expect(text).toContain("ana");
    expect(text).not.toContain("bug");
    expect(text).not.toContain("·");
    expect(row.container.querySelector("img")).toBeNull();
    // The first line's one glyph is the kind; the provider mark is not drawn.
    expect(title(row.container).parentElement?.querySelectorAll("svg")).toHaveLength(1);
    expect(row.getByRole("button").getAttribute("aria-current")).toBe("true");
    expect(row.getByRole("button").className).not.toMatch(/animate|transition-\[/);
  });

  it("draws the host's glyph with two hosts and none with one", () => {
    const two = render(<InboxRow item={pr()} active={false} environmentId="env_box" showSource={false} onSelect={() => {}} />);
    expect(two.container.querySelector("[data-host-glyph]")?.getAttribute("aria-label")).toBe("The box");
    cleanup();
    const saved = h.environments;
    h.environments = [saved[0]];
    try {
      const one = render(<InboxRow item={pr()} active={false} environmentId="local" showSource={false} onSelect={() => {}} />);
      expect(one.container.querySelector("[data-host-glyph]")).toBeNull();
    } finally {
      h.environments = saved;
    }
  });
});
