// @vitest-environment jsdom
/**
 * The preamble editor: the word count follows the text, the preview shows
 * only while there is text (a project without its own says it takes the
 * workspace default), Save stays off until something changed, and a save
 * closes through the dialog's exit with one onClose.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProjectMeta, WorkspaceMeta } from "../lib/tcserver/types";

const h = vi.hoisted(() => ({ setProject: vi.fn(), setWorkspace: vi.fn() }));

vi.mock("../lib/tcserver/projects", () => ({
  setProjectPreamble: (...args: unknown[]) => h.setProject(...args),
  setWorkspacePreamble: (...args: unknown[]) => h.setWorkspace(...args),
}));
vi.mock("../lib/projectHome", () => ({
  useProjectHome: (project: ProjectMeta) => ({ home: project, workspace: null, blocked: null, linked: false, hostName: "This Mac" }),
}));
vi.mock("../surfaces/AgentMarkdown", () => ({
  AgentMarkdown: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div>,
}));

import { PreambleDialog } from "./PreambleDialog";

const WS: WorkspaceMeta = {
  id: "w",
  environmentId: "local",
  name: "temp-code",
  path: "/x",
  git: true,
  createdAt: 1,
  preamble: "Run the gate before you merge.",
} as WorkspaceMeta;
const project = (over: Partial<ProjectMeta> = {}): ProjectMeta => ({
  id: "p",
  environmentId: "local",
  workspaceId: "w",
  name: "Alpha",
  mode: "local",
  branch: null,
  cwd: "/x",
  archived: false,
  createdAt: 1,
  ...over,
});

const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));
const field = () => screen.getByLabelText("Project rules") as HTMLTextAreaElement;
const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
const preview = () => document.querySelector("[data-preamble-preview]") as HTMLElement;

// jsdom has no Web Animations; Base UI's ScrollArea asks for them.
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

beforeEach(() => {
  h.setProject.mockReset().mockResolvedValue(undefined);
  h.setWorkspace.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("PreambleDialog", () => {
  it("the word count follows typing", () => {
    render(<PreambleDialog scope={{ kind: "project", project: project({ preamble: "one two" }), workspace: WS }} onClose={() => {}} />);
    const count = () => document.querySelector("[data-preamble-count]")?.textContent;
    expect(count()).toBe("2 words");
    fireEvent.change(field(), { target: { value: "one" } });
    expect(count()).toBe("1 word");
  });

  it("previews only while there is text, and an empty project says it takes the workspace default", async () => {
    render(<PreambleDialog scope={{ kind: "project", project: project({ preamble: "Keep it small." }), workspace: WS }} onClose={() => {}} />);
    await flush();
    expect((await screen.findByTestId("markdown")).textContent).toBe("Keep it small.");
    fireEvent.change(field(), { target: { value: "  " } });
    expect(screen.queryByTestId("markdown")).toBeNull();
    expect(preview().querySelector("[data-preamble-fallback]")?.textContent).toBe("Empty: threads take the workspace default (6 words).");
  });

  it("a workspace's own editor has no fallback line", () => {
    render(<PreambleDialog scope={{ kind: "workspace", workspace: { ...WS, preamble: "" } }} onClose={() => {}} />);
    expect(screen.getByText("Workspace preamble")).toBeTruthy();
    expect(preview().textContent).toBe("");
  });

  it("Save stays off until something changed, and switching the rules off says so", () => {
    render(<PreambleDialog scope={{ kind: "project", project: project({ preamble: "Rules." }), workspace: WS }} onClose={() => {}} />);
    expect(save().disabled).toBe(true);
    fireEvent.change(field(), { target: { value: "Rules. " } });
    expect(save().disabled).toBe(true);
    expect(screen.queryByText("Kept, but nothing is prepended.")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Apply to new threads" }));
    expect(screen.getByText("Kept, but nothing is prepended.")).toBeTruthy();
    expect(save().disabled).toBe(false);
  });

  it("the variables are named in mono with their meaning on hover, never a title=", () => {
    render(<PreambleDialog scope={{ kind: "project", project: project(), workspace: WS }} onClose={() => {}} />);
    const line = document.querySelector("[data-preamble-variables]") as HTMLElement;
    expect([...line.querySelectorAll("code")].map((c) => c.textContent)).toEqual(["{{worktree}}", "{{project}}", "{{host}}"]);
    expect(document.querySelector("[title]")).toBeNull();
  });

  it("a variable's meaning shows on keyboard focus, with the tooltips still cold", () => {
    render(<PreambleDialog scope={{ kind: "project", project: project(), workspace: WS }} onClose={() => {}} />);
    const worktree = screen.getByLabelText(/^\{\{worktree\}\}:/);
    expect(document.querySelector("[data-preamble-meaning]")).toBeNull();
    fireEvent.focus(worktree);
    const meaning = document.querySelector("[data-preamble-meaning]") as HTMLElement;
    expect(meaning.textContent).toBe(worktree.getAttribute("aria-label")!.replace("{{worktree}}: ", ""));
    fireEvent.blur(worktree);
    expect(document.querySelector("[data-preamble-meaning]")).toBeNull();
  });

  it("Save writes the project's text and closes once", async () => {
    const onClose = vi.fn();
    render(<PreambleDialog scope={{ kind: "project", project: project(), workspace: WS }} onClose={onClose} />);
    await waitFor(() => expect(document.activeElement).toBe(field()));
    fireEvent.change(field(), { target: { value: "New rules" } });
    await act(async () => {
      fireEvent.click(save());
    });
    expect(h.setProject).toHaveBeenCalledWith("p", "New rules", true);
    // After the exit has played, once.
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Use workspace default clears the project's text", () => {
    render(<PreambleDialog scope={{ kind: "project", project: project({ preamble: "Mine." }), workspace: WS }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Use workspace default" }));
    expect(field().value).toBe("");
    expect(screen.queryByRole("button", { name: "Use workspace default" })).toBeNull();
  });
});
