// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The notes surface on the design system: the filter is an InputGroup, a
 * note's row is a ghost Button, the note's Preview and Source are line tabs,
 * the source field is the Textarea and Delete asks first.
 */

const h = vi.hoisted(() => ({
  notes: [
    { id: "n1", slug: "gate-notes", title: "Gate notes", body: "The gate holds a merge.", createdAt: 1, updatedAt: 2 },
    { id: "n2", slug: "deploy", title: "Deploy", body: "Ship on green.", createdAt: 1, updatedAt: 1 },
  ],
}));

vi.mock("../lib/notes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/notes")>()),
  loadNotes: () => Promise.resolve(h.notes),
  upsertNote: vi.fn((_env: string, note: { id: string }) => Promise.resolve({ ...h.notes[0], ...note })),
  deleteNote: vi.fn(() => Promise.resolve()),
  createNote: vi.fn(),
}));
vi.mock("../lib/connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/connection")>()),
  registry: { primary: () => ({ environmentId: "local" }) },
}));
vi.mock("../hooks/useTabGroupLogos", () => ({ useTabGroupLogos: () => ({}) }));
vi.mock("./AgentMarkdown", () => ({
  AgentMarkdown: ({ text }: { text: string }) => <div data-markdown>{text}</div>,
  MarkdownSourceHighlight: ({ text }: { text: string }) => <span>{text}</span>,
}));
vi.mock("../chrome/TitleBar", () => ({ OverlayNav: () => null }));
vi.mock("../chrome/WindowControls", () => ({ WindowControls: () => null }));

import { NotesView } from "./NotesView";

afterEach(cleanup);

async function mount() {
  const view = render(<NotesView besideRail onClose={() => {}} />);
  await act(async () => {});
  return view;
}

describe("the notes view", () => {
  it("filters through the group field and selects a note from its row button", async () => {
    const view = await mount();
    const filter = view.getByLabelText("Filter notes");
    expect(filter.closest('[data-slot="input-group"]')).not.toBeNull();
    const row = view.getByRole("button", { name: /Deploy/ });
    expect(row.getAttribute("data-slot")).toBe("button");
    fireEvent.click(row);
    expect(row.getAttribute("aria-current")).toBe("true");
    expect((view.getByLabelText("Note title") as HTMLInputElement).value).toBe("Deploy");
    fireEvent.change(filter, { target: { value: "gate" } });
    expect(view.queryByRole("button", { name: /Deploy/ })).toBeNull();
  });

  it("switches Preview and Source with line tabs, the source a Textarea", async () => {
    const view = await mount();
    // The view remembers the last note across showings; pick the first.
    fireEvent.click(view.getByRole("button", { name: /Gate notes/ }));
    const source = view.getByRole("tab", { name: "Source" });
    await act(async () => {
      fireEvent.click(source);
    });
    expect(source.getAttribute("aria-selected")).toBe("true");
    const field = view.getByLabelText("Note source");
    expect(field.getAttribute("data-slot")).toBe("textarea");
    expect((field as HTMLTextAreaElement).value).toBe("The gate holds a merge.");
  });

  it("asks before Delete", async () => {
    const view = await mount();
    const del = view.getByRole("button", { name: "Delete" });
    expect(del.getAttribute("data-slot")).toBe("button");
    await act(async () => {
      fireEvent.click(del);
    });
    expect(view.getByText("Delete note?")).toBeTruthy();
  });
});
