// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { pushListeners, request } = vi.hoisted(() => ({
  pushListeners: [] as ((push: unknown) => void)[],
  request: vi.fn((method: string, params: { sessionId: string; text?: string }) => {
    if (method === "session.notes.get") {
      return Promise.resolve({ text: "## Goal\n\nShip the notes panel.\n\n## State\n\n- panel in flight\n", updatedAt: Date.now() - 120_000, path: "/p/notes.md" });
    }
    if (method === "session.notes.set") return Promise.resolve({ text: params.text, updatedAt: Date.now(), path: "/p/notes.md" });
    return Promise.resolve(null);
  }),
}));

vi.mock("../../lib/connection", () => {
  const link = {
    environmentId: "local",
    request,
    onOpen: () => () => {},
    onPush: (l: (push: unknown) => void) => {
      pushListeners.push(l);
      return () => {};
    },
  };
  return {
    registry: {
      linkOf: () => link,
      onLink: (listener: (link: unknown, event: string) => void) => {
        listener(link, "added");
        return () => {};
      },
    },
  };
});
// The markdown renderer pulls the code-block stack; the panel's contract is what it hands over.
vi.mock("../AgentMarkdown", () => ({
  AgentMarkdown: ({ text }: { text: string }) => <div data-testid="md">{text}</div>,
  MarkdownSourceHighlight: ({ text }: { text: string }) => <span>{text}</span>,
}));

import { resetNotesStore } from "../../lib/threadNotes";
import type { Session } from "../../lib/session";
import { NotesPanel, resetNotesPanel } from "./NotesPanel";

const session = { id: "s1", environmentId: "local", title: "Notes feature", cwd: "/p", status: "idle", blocks: [] } as unknown as Session;
const push = (p: unknown): void => {
  for (const l of pushListeners) l(p);
};
const flush = (): Promise<void> => act(() => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  resetNotesStore();
  resetNotesPanel();
  request.mockClear();
  Object.assign(navigator, { clipboard: { writeText: vi.fn(() => Promise.resolve()) } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("NotesPanel", () => {
  it("opens from its rail and renders the notes live", async () => {
    render(<NotesPanel session={session} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Expand notes" }));
    await flush();
    expect(screen.getByTestId("md").textContent).toContain("Ship the notes panel.");
    expect(screen.getByText(/updated 2m/)).toBeTruthy();
    act(() => push({ push: "notes", sessionId: "s1", doc: { text: "## Goal\n\nShipped.\n", updatedAt: Date.now(), path: "/p/notes.md" } }));
    expect(screen.getByTestId("md").textContent).toContain("Shipped.");
  });

  it("the person's edit saves on Done as the whole text", async () => {
    render(<NotesPanel session={session} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Expand notes" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    const field = screen.getByLabelText("Notes source") as HTMLTextAreaElement;
    expect(field.value).toContain("## State\n\n- panel in flight");
    fireEvent.change(field, { target: { value: "## Goal\n\nShip.\n\n## State\n\n- panel done\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Done editing" }));
    await flush();
    expect(request).toHaveBeenCalledWith("session.notes.set", { sessionId: "s1", text: "## Goal\n\nShip.\n\n## State\n\n- panel done\n" });
    expect(screen.getByTestId("md").textContent).toContain("panel done");
  });

  it("a push while editing is offered, never forced into the draft", async () => {
    render(<NotesPanel session={session} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Expand notes" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    const field = screen.getByLabelText("Notes source") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "## Goal\n\nmine\n" } });
    act(() => push({ push: "notes", sessionId: "s1", doc: { text: "## Goal\n\ntheirs\n", updatedAt: Date.now(), path: "/p/notes.md" } }));
    expect(field.value).toBe("## Goal\n\nmine\n");
    expect(screen.getByText(/updated the notes while you edited/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load theirs" }));
    expect(field.value).toBe("## Goal\n\ntheirs\n");
  });

  it("Copy as brief puts the first message of a successor on the clipboard", async () => {
    render(<NotesPanel session={session} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Expand notes" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Copy as brief" }));
    await flush();
    const written = (navigator.clipboard.writeText as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(written.startsWith('Continue the work of thread "Notes feature".')).toBe(true);
    expect(written).toContain("**State**\n\n- panel in flight");
  });

  it("an empty thread offers to start the notes", async () => {
    request.mockImplementationOnce(() => Promise.resolve({ text: "", updatedAt: null, path: null }));
    render(<NotesPanel session={session} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Expand notes" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Start the notes" }));
    const field = screen.getByLabelText("Notes source") as HTMLTextAreaElement;
    expect(field.value).toBe("## Goal\n\n## Decisions\n\n## State\n\n## Pointers\n\n## Open questions\n");
  });
});
