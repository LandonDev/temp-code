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
  AgentMarkdown: ({ text, size }: { text: string; size?: string }) => (
    <div data-testid="md" data-size={size}>
      {text}
    </div>
  ),
  MarkdownSourceHighlight: ({ text }: { text: string }) => <span>{text}</span>,
}));

// Base UI's scroll area asks for running animations; jsdom has none.
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

import { resetNotesStore } from "../../lib/threadNotes";
import type { Session } from "../../lib/session";
import { NotesBody } from "./NotesPanel";
import { resetTooltips, tooltipChunk, warmTooltips } from "../../components/ui/tooltip";

const session = { id: "s1", environmentId: "local", title: "Notes feature", cwd: "/p", status: "idle", blocks: [] } as unknown as Session;
const push = (p: unknown): void => {
  for (const l of pushListeners) l(p);
};
const flush = (): Promise<void> => act(() => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  resetNotesStore();
  request.mockClear();
  Object.assign(navigator, { clipboard: { writeText: vi.fn(() => Promise.resolve()) } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("NotesBody", () => {
  it("renders the notes live", async () => {
    render(<NotesBody session={session} />);
    await flush();
    expect(screen.getByTestId("md").textContent).toContain("Ship the notes panel.");
    expect(screen.getByText("Updated 2m ago")).toBeTruthy();
    // The section's top row: 36px on the panel's 12px inset, as Changes, Build, Notes and Files all draw it.
    const top = screen.getByText("Updated 2m ago").closest('[data-slot="section-top"]')!;
    expect(top.className).toContain("h-9");
    expect(top.className).toContain("px-3");

    expect(screen.getByTestId("md").dataset.size).toBe("compact");
    act(() => push({ push: "notes", sessionId: "s1", doc: { text: "## Goal\n\nShipped.\n", updatedAt: Date.now(), path: "/p/notes.md" } }));
    expect(screen.getByTestId("md").textContent).toContain("Shipped.");
  });

  it("the person's edit saves on Done as the whole text", async () => {
    render(<NotesBody session={session} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    const field = screen.getByLabelText("Notes source") as HTMLTextAreaElement;
    expect(field.value).toContain("## State\n\n- panel in flight");
    fireEvent.change(field, { target: { value: "## Goal\n\nShip.\n\n## State\n\n- panel done\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await flush();
    expect(request).toHaveBeenCalledWith("session.notes.set", { sessionId: "s1", text: "## Goal\n\nShip.\n\n## State\n\n- panel done\n" });
    expect(screen.getByTestId("md").textContent).toContain("panel done");
  });

  it("a push while editing is offered, never forced into the draft", async () => {
    render(<NotesBody session={session} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    const field = screen.getByLabelText("Notes source") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "## Goal\n\nmine\n" } });
    act(() => push({ push: "notes", sessionId: "s1", doc: { text: "## Goal\n\ntheirs\n", updatedAt: Date.now(), path: "/p/notes.md" } }));
    expect(field.value).toBe("## Goal\n\nmine\n");
    expect(screen.getByText("The thread updated the notes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load theirs" }));
    expect(field.value).toBe("## Goal\n\ntheirs\n");
  });

  it("a draft still waiting on its debounce lands when the body leaves", async () => {
    const { unmount } = render(<NotesBody session={session} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    const field = screen.getByLabelText("Notes source") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "## Goal\n\nTyped, then switched sections\n" } });
    unmount();
    await flush();
    expect(request).toHaveBeenCalledWith("session.notes.set", { sessionId: "s1", text: "## Goal\n\nTyped, then switched sections\n" });
  });

  it("Copy as brief puts the first message of a successor on the clipboard", async () => {
    render(<NotesBody session={session} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Copy as brief" }));
    await flush();
    const written = (navigator.clipboard.writeText as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(written.startsWith('Continue the work of thread "Notes feature".')).toBe(true);
    expect(written).toContain("**State**\n\n- panel in flight");
  });

  it("Escape in the editor is Done", async () => {
    render(<NotesBody session={session} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    const field = screen.getByLabelText("Notes source") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "## Goal\n\nEscaped.\n" } });
    fireEvent.keyDown(field, { key: "Escape" });
    await flush();
    expect(screen.queryByLabelText("Notes source")).toBeNull();
    expect(request).toHaveBeenCalledWith("session.notes.set", { sessionId: "s1", text: "## Goal\n\nEscaped.\n" });
  });

  it("a failed save says so in red", async () => {
    render(<NotesBody session={session} />);
    await flush();
    request.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    fireEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    fireEvent.change(screen.getByLabelText("Notes source"), { target: { value: "## Goal\n\nlost?\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await flush();
    const mark = screen.getByText("Save failed").closest<HTMLElement>('[data-slot="status-mark"]')!;
    expect(mark.dataset.state).toBe("failed");
  });

  it("a first draft that failed to save stays: Save failed, and the pencil brings it back to retry", async () => {
    request.mockImplementationOnce(() => Promise.resolve({ text: "", updatedAt: null, path: null }));
    render(<NotesBody session={session} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Start the notes" }));
    fireEvent.change(screen.getByLabelText("Notes source"), { target: { value: "## Goal\n\nfirst\n" } });
    request.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await flush();
    expect(screen.queryByText("No notes yet")).toBeNull();
    expect(screen.getByText("Save failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    expect((screen.getByLabelText("Notes source") as HTMLTextAreaElement).value).toBe("## Goal\n\nfirst\n");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await flush();
    expect(request).toHaveBeenLastCalledWith("session.notes.set", { sessionId: "s1", text: "## Goal\n\nfirst\n" });
  });

  it("loading shows skeleton lines, not words", () => {
    request.mockImplementationOnce(() => new Promise(() => {}));
    render(<NotesBody session={session} />);
    expect(screen.getByLabelText("Loading notes").getAttribute("aria-busy")).toBe("true");
    // Lines on the markdown's 22px pitch: 12px bars centred in 22px boxes, no gap between them.
    const loading = screen.getByLabelText("Loading notes");
    expect(loading.className).not.toMatch(/gap-/);
    const lines = [...loading.querySelectorAll<HTMLElement>('[data-slot="notes-skeleton-line"]')];
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.className.split(/\s+/)).toEqual(expect.arrayContaining(["h-[22px]", "items-center"]));
      expect(line.firstElementChild!.className.split(/\s+/)).toContain("h-3");
    }
    expect(screen.queryByRole("button", { name: "Edit notes" })).toBeNull();
  });

  it("tooltips warming keep the notes' scroller and the editor: the provider holds the top row alone", async () => {
    resetTooltips();
    render(<NotesBody session={session} />);
    await flush();
    const scroller = document.querySelector<HTMLElement>('[data-slot="notes-scroller"]')!;
    scroller.scrollTop = 40;
    await tooltipChunk.load();
    act(() => warmTooltips());
    await flush();
    expect(document.querySelector('[data-slot="notes-scroller"]')).toBe(scroller);
    expect(scroller.scrollTop).toBe(40);
    // The editor too: a warm-up while editing keeps the field and its text.
    resetTooltips();
    fireEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    const field = screen.getByLabelText("Notes source") as HTMLTextAreaElement;
    await tooltipChunk.load();
    act(() => warmTooltips());
    await flush();
    expect(screen.getByLabelText("Notes source")).toBe(field);
    resetTooltips();
  });

  it("an empty thread offers to start the notes", async () => {
    request.mockImplementationOnce(() => Promise.resolve({ text: "", updatedAt: null, path: null }));
    render(<NotesBody session={session} />);
    await flush();
    expect(screen.getByText("No notes yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start the notes" }));
    const field = screen.getByLabelText("Notes source") as HTMLTextAreaElement;
    expect(field.value).toBe("## Goal\n\n## Decisions\n\n## State\n\n## Pointers\n\n## Open questions\n");
  });
});
