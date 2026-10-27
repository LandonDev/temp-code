// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/tcserver/commands", () => ({ rename: vi.fn(async () => undefined) }));

import * as commands from "../../../lib/tcserver/commands";
import { RenameThreadDialog } from "./RenameThreadDialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RenameThreadDialog", () => {
  it("opens with the title focused and selected, renames, then closes once", async () => {
    const onClose = vi.fn();
    render(<RenameThreadDialog sessionId="s1" title="Search screen" onClose={onClose} />);
    const field = screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe("Search screen".length);
    fireEvent.change(field, { target: { value: "Search results" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    });
    expect(commands.rename).toHaveBeenCalledWith("s1", "Search results");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("an unchanged title closes without a call; an empty one cannot be saved", async () => {
    const onClose = vi.fn();
    render(<RenameThreadDialog sessionId="s1" title="Search screen" onClose={onClose} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(commands.rename).not.toHaveBeenCalled();
    cleanup();
    render(<RenameThreadDialog sessionId="s1" title="Search screen" onClose={onClose} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "  " } });
    expect((screen.getByRole("button", { name: "Rename" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
