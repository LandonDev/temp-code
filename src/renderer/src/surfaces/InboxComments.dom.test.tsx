// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The inbox's comments and its pull request diff on the design system: a
 * comment's facts sit apart by margin (no dots), Reply and the post button
 * are `Button`s, the field is the `Textarea`, and a file's header row is a
 * ghost `Button` that folds its patch.
 */

vi.mock("../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/native")>()),
  openUrl: vi.fn(),
}));
vi.mock("./AgentMarkdown", () => ({
  AgentMarkdown: ({ text }: { text: string }) => <div>{text}</div>,
}));

import { InboxComments, InboxCommentForm } from "./InboxComments";
import { InboxPrDiff } from "./InboxPrDiff";

afterEach(cleanup);

const comment = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  kind: "review",
  author: "ana",
  body: "Looks good.",
  createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  url: "",
  state: "APPROVED",
  path: "src/gate.ts",
  line: 12,
  resolved: false,
  threadId: "t1",
  replies: [],
  ...over,
});

describe("the inbox comments", () => {
  it("lists a comment's facts without dots, the review word in its tone", () => {
    const view = render(
      <InboxComments
        thread={{ comments: [comment()], truncated: true }}
        loading={false}
        error={null}
        cwd="/srv/app"
        provider="github"
      />,
    );
    expect(view.getByRole("heading", { name: "1 comment" })).toBeTruthy();
    expect(view.container.textContent).not.toContain("·");
    expect(view.getByText("the latest, more on GitHub")).toBeTruthy();
    expect(view.getByText("src/gate.ts:12").className).not.toContain("text-success");
  });

  it("offers Reply as a button that names the comment", () => {
    const onReply = vi.fn();
    const view = render(
      <InboxComments
        thread={{ comments: [comment()], truncated: false }}
        loading={false}
        error={null}
        cwd="/srv/app"
        provider="github"
        replyMode="thread"
        onReply={onReply}
      />,
    );
    const reply = view.getByRole("button", { name: "Reply" });
    expect(reply.getAttribute("data-slot")).toBe("button");
    fireEvent.click(reply);
    expect(onReply).toHaveBeenCalledWith({ id: "c1", author: "ana", threadId: "t1" });
  });

  it("posts on ⌘↩ from the field and shows a spinner while it posts", async () => {
    let finish = () => {};
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const props = { replyTo: null, error: null, onCancelReply: () => {}, onSubmit };
    const view = render(<InboxCommentForm {...props} posting={false} />);
    const field = view.getByRole("textbox", { name: "Comment" });
    expect(field.getAttribute("data-slot")).toBe("textarea");
    const post = view.getByRole("button", { name: "Comment" });
    expect((post as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: "Ship it" } });
    expect((post as HTMLButtonElement).disabled).toBe(false);
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenCalledWith("Ship it");
    view.rerender(<InboxCommentForm {...props} posting />);
    const posting = view.getByRole("button", { name: /Posting/ });
    expect(posting.querySelector('[data-slot="spinner"]')).not.toBeNull();
    await act(async () => finish());
  });
});

describe("the pull request diff", () => {
  it("folds a file's patch from its header button", () => {
    const view = render(
      <InboxPrDiff
        diff={{
          files: [
            { path: "a.ts", additions: 1, deletions: 0, status: "modified" },
            { path: "b.ts", additions: 0, deletions: 1, status: "modified" },
          ],
          patch: [
            "diff --git a/a.ts b/a.ts",
            "--- a/a.ts",
            "+++ b/a.ts",
            "@@ -1,1 +1,2 @@",
            " const a = 1;",
            "+const b = 2;",
            "diff --git a/b.ts b/b.ts",
            "--- a/b.ts",
            "+++ b/b.ts",
            "@@ -1,2 +1,1 @@",
            " const a = 1;",
            "-const b = 2;",
          ].join("\n"),
          additions: 1,
          deletions: 1,
          truncated: false,
        } as never}
      />,
    );
    const rows = view.getAllByRole("button", { expanded: false });
    expect(rows[0].getAttribute("data-slot")).toBe("button");
    expect(view.getAllByRole("button", { expanded: true })).toHaveLength(1);
    fireEvent.click(rows[0]);
    expect(view.getAllByRole("button", { expanded: true })).toHaveLength(2);
  });
});
