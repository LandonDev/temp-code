// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../../lib/session";
import { SelectSessionContext } from "../AgentMarkdown";
import { ActionRow } from "./ActionRow";
import { ActivityRow } from "./ActivityRow";

// FileRefMenu asks the native bridge which editor opens a file; jsdom has none.
vi.mock("../../lib/editorConfig", () => ({ useEditorConfig: () => null }));

vi.mock("../../lib/threadMentions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/threadMentions")>()),
  useTitlesOf: () => (id: string) => (id === "t1" ? "Auth rewrite" : undefined),
}));

function call(
  name: string,
  input: unknown,
  extra: Partial<NonNullable<Block["tool"]>> & Partial<Pick<Block, "approval">> = {},
): Block {
  const { approval, ...tool } = extra;
  return {
    id: `b-${name}`,
    role: "tool",
    text: name,
    ...(approval ? { approval } : {}),
    tool: { callId: `c-${name}`, title: name, status: "completed", name, input, ...tool },
  };
}

afterEach(cleanup);

describe("ActionRow", () => {
  it("a read says Read and the basename, has no caret, and opens the file at its line", () => {
    const onOpenFile = vi.fn();
    const { container, getByRole } = render(
      <ActionRow block={call("Read", { file_path: "/repo/src/types.ts", offset: 41 })} cwd="/repo" onOpenFile={onOpenFile} />,
    );
    expect(container.textContent).toContain("Read");
    expect(container.textContent).toContain("types.ts");
    expect(container.textContent).not.toContain("src/types.ts");
    const button = getByRole("button", { name: "Read types.ts" });
    expect(button.getAttribute("aria-expanded")).toBeNull();
    fireEvent.click(button);
    expect(onOpenFile).toHaveBeenCalledWith("/repo/src/types.ts", { line: 41 }, undefined);
  });

  it("a run row starts closed with a caret and opens onto its body", async () => {
    const block = call("Bash", { command: "npm test" }, { detail: "12 passed" });
    const { getByRole, container } = render(<ActionRow block={block} cwd="/repo" />);
    const button = getByRole("button", { name: "Ran the tests" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("12 passed");
    await act(async () => {
      fireEvent.click(button);
    });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("12 passed");
  });

  it("a failed row shows the failed glyph and keeps its verb muted", () => {
    const { getByLabelText, getByText } = render(
      <ActionRow block={call("Bash", { command: "npm test" }, { status: "failed" })} />,
    );
    expect(getByLabelText("Failed").getAttribute("class")).toContain("text-destructive");
    expect(getByText("Ran").className).toContain("text-muted-foreground");
    expect(getByText("Ran").className).not.toContain("destructive");
  });

  it("a running row shows the spinner and the live verb", () => {
    const { container, getByText } = render(
      <ActionRow block={call("Bash", { command: "npm test" }, { status: "running" })} />,
    );
    expect(container.querySelector('[data-slot="spinner"]')).not.toBeNull();
    expect(getByText("Running")).toBeTruthy();
  });

  it("a connector row leads with its mark and offers Reconnect", () => {
    const block = call(
      "mcp__linear__save_issue",
      {},
      { display: { app: "linear", action: "Saved issue" }, reauth: { app: "linear", url: "https://linear.app/auth" } },
    );
    const { container, getByRole } = render(<ActionRow block={block} />);
    expect(container.querySelector('[data-glyph] [aria-label="Linear"]')).not.toBeNull();
    expect(getByRole("button", { name: /Reconnect Linear/ })).toBeTruthy();
  });

  it("an app row's object opens the thread it names", () => {
    const onSelect = vi.fn();
    const { getByRole } = render(
      <SelectSessionContext.Provider value={onSelect}>
        <ActionRow block={call("mcp__app__app_read_thread", { threadId: "t1" })} />
      </SelectSessionContext.Provider>,
    );
    fireEvent.click(getByRole("button", { name: "Auth rewrite" }));
    expect(onSelect).toHaveBeenCalledWith("t1");
  });

  it("an opened run row shows the tool's name, the command and what it printed", async () => {
    const output = Array.from({ length: 30 }, (_, n) => `line ${n + 1}`).join("\n");
    const block = call("Bash", { command: "cd x && npm test 2>&1 | tail -40" }, { detail: output });
    const { getByRole, container, getByText } = render(<ActionRow block={block} />);
    await act(async () => {
      fireEvent.click(getByRole("button", { name: /^Ran/ }));
    });
    expect(getByText("Bash")).toBeTruthy();
    const pre = container.querySelector("pre")!;
    expect(pre.textContent).toBe("$ cd x && npm test 2>&1 | tail -40");
    expect(getByText("npm").className).toContain("text-info");
    expect(container.textContent).toContain("line 24");
    expect(container.textContent).not.toContain("line 25");
    expect(getByText("6 more lines")).toBeTruthy();
  });

  it("a failed run's output reads in red", async () => {
    const block = call("Bash", { command: "npm test" }, { status: "failed", detail: "1 failed" });
    const { getByRole, getByText } = render(<ActionRow block={block} />);
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Ran the tests" }));
    });
    expect(getByText("1 failed").className).toContain("text-destructive");
  });

  it("a settled run with nothing printed says so", async () => {
    const { getByRole, getByText } = render(<ActionRow block={call("Bash", { command: "true" })} />);
    await act(async () => {
      fireEvent.click(getByRole("button", { expanded: false }));
    });
    expect(getByText("(no output)")).toBeTruthy();
  });

  it("a body still on the server says it is loading", async () => {
    const block = call("Bash", { command: "npm test" }, { omitted: { sessionId: "s", seqs: [1], bytes: 12_000, loading: true } });
    const { getByRole, container } = render(<ActionRow block={block} />);
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Ran the tests" }));
    });
    expect(container.textContent).toContain("Loading");
  });

  it("the raw toggle swaps the formatted view for the verbatim one", async () => {
    const block = call("Grep", { pattern: "needle", path: "src" });
    const { getByRole, container } = render(<ActionRow block={block} />);
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Searched for needle" }));
    });
    expect(container.querySelector("pre")!.textContent).toBe("needle in src");
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Show raw" }));
    });
    expect(container.querySelector("pre")!.textContent).toContain('"pattern"');
    expect(getByRole("button", { name: "Show formatted" })).toBeTruthy();
  });

  it("a call waiting on approval says its live verb and carries the card once, with no body of its own", () => {
    const onApproval = vi.fn();
    const block = call("Bash", { command: "git push", description: "Push master" }, { status: "pending", approval: { requestId: 7 } });
    const { container, getAllByRole, getByRole, queryByRole } = render(<ActionRow block={block} onApproval={onApproval} />);
    expect(container.textContent).toContain("Pushing");
    expect(container.querySelector('[data-glyph] [data-state="waiting"]')).not.toBeNull();
    expect(queryByRole("button", { expanded: false })).toBeNull();
    expect(getAllByRole("button", { name: "Allow" })).toHaveLength(1);
    fireEvent.click(getByRole("button", { name: "Allow" }));
    expect(onApproval).toHaveBeenCalledWith(7, "allow");
  });

  it("a decided call is an ordinary row again, with its caret", () => {
    const block = call("Bash", { command: "git push", description: "Push master" }, { approval: { requestId: 7, decided: "allow" } });
    const { getByRole, queryByRole } = render(<ActionRow block={block} />);
    expect(getByRole("button", { name: "Pushed master" }).getAttribute("aria-expanded")).toBe("false");
    expect(queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("an edit waiting on approval is an action row, not an edit row", () => {
    const block = call("Edit", { file_path: "/repo/a.ts", old_string: "a", new_string: "b" }, { status: "pending", approval: { requestId: 3 } });
    const { container, getAllByRole } = render(<ActivityRow block={block} cwd="/repo" />);
    expect(container.textContent).toContain("Editing");
    expect(container.querySelector('[data-glyph] [data-state="waiting"]')).not.toBeNull();
    expect(getAllByRole("button", { name: "Allow" })).toHaveLength(1);
  });
});
