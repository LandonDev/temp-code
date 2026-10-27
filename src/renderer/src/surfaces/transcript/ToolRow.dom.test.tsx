// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../../lib/session";
import { SelectSessionContext } from "../AgentMarkdown";
import { ActionRow } from "./ActionRow";

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
});
