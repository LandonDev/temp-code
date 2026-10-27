// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The inbox detail's header: one line of facts without dots, the review
 * decision as a plain word, a pull request's Summary and Code as line tabs,
 * and Send to agent showing a spinner while the start is pending.
 */

const h = vi.hoisted(() => ({ item: null as unknown }));

vi.mock("../lib/inboxSelection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/inboxSelection")>()),
  useInboxSelection: () => h.item,
}));
vi.mock("../lib/tcserver/workspaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tcserver/workspaces")>()),
  useWorkspaceCatalog: () => ({ workspaces: [], projects: [] }),
  useWorkspaceIcon: () => undefined,
}));
vi.mock("../lib/githubTasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/githubTasks")>()),
  peekGithubWorkItemDetails: () => null,
  peekGithubWorkItemThread: () => null,
  peekGithubPrDiff: () => null,
  githubWorkItemDetails: () => Promise.resolve({ body: "", author: "ana" }),
  githubWorkItemThread: () => Promise.resolve({ comments: [] }),
  githubPrDiff: () => Promise.resolve(null),
}));
vi.mock("../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/native")>()),
  openUrl: vi.fn(),
}));
vi.mock("./AgentMarkdown", () => ({ AgentMarkdown: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock("./InboxComments", () => ({ InboxComments: () => null, InboxCommentForm: () => null }));
vi.mock("./InboxPrDiff", () => ({ InboxPrDiff: () => null }));

import { InboxDetailPane } from "./InboxView";

const item = (over: Record<string, unknown> = {}) => ({
  kind: "pr",
  number: 12,
  title: "Fix the gate",
  url: "https://github.com/me/app/pull/12",
  state: "open",
  updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
  labels: [{ name: "bug", color: "d73a4a" }],
  assignees: [],
  draft: false,
  repo: "me/app",
  projectPath: "/srv/app",
  provider: "github",
  author: { login: "ana" },
  reviewDecision: "APPROVED",
  baseRefName: "master",
  headRefName: "fix-gate",
  ...over,
});

afterEach(() => {
  cleanup();
  h.item = null;
});

async function mount(onStart?: () => Promise<void>) {
  const view = render(<InboxDetailPane cwd="/srv/app" onStart={onStart} />);
  await act(async () => {});
  return view;
}

describe("the inbox detail", () => {
  it("says its facts without dots and the review decision as a plain word", async () => {
    h.item = item();
    const view = await mount();
    const header = view.container.querySelector("header") as HTMLElement;
    expect(header.textContent).not.toContain("·");
    const approved = view.getByText("Approved");
    expect(approved.className).not.toMatch(/text-success|text-destructive/);
    expect(header.textContent).toContain("Open");
    expect(view.getByRole("heading", { name: "Fix the gate" }).className).toContain("text-[16px]");
  });

  it("puts a pull request's Summary and Code on line tabs", async () => {
    h.item = item();
    const view = await mount();
    const list = view.getByRole("tablist", { name: "Pull request sections" });
    expect(list.getAttribute("data-variant")).toBe("line");
    expect(view.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Summary", "Code"]);
    expect(view.getByRole("button", { name: "Review on GitHub" })).toBeTruthy();
  });

  it("gives an issue no tab row and shows a spinner on Send to agent while it starts", async () => {
    h.item = item({ kind: "issue", reviewDecision: undefined });
    let finish: () => void = () => {};
    const onStart = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const view = await mount(onStart);
    expect(view.queryByRole("tablist")).toBeNull();
    const send = view.getByRole("button", { name: /Send to agent/ });
    expect(send.querySelector('[data-slot="spinner"]')).toBeNull();
    await act(async () => {
      fireEvent.click(send);
    });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(send.querySelector('[data-slot="spinner"]')).not.toBeNull();
    await act(async () => finish());
    expect(send.querySelector('[data-slot="spinner"]')).toBeNull();
  });

  it("draws nothing without a selection", async () => {
    const view = await mount();
    expect(view.container.querySelector("[role=region]")?.textContent).toBe("");
  });
});
