// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Button } from "./button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle, AlertDialogTrigger } from "./dialog";
import { Switch } from "./switch";
import { STATUS_TONE, STATUS_WORD, StatusMark, statusNeedsYou, type ThreadState } from "./status";
import { Kbd } from "./kbd";

vi.mock("@renderer/hooks/paneVisibility", () => ({ usePaneVisible: () => true }));

afterEach(cleanup);

describe("Button", () => {
  it("is flat: no raise classes, a variant on the slot, a press scale", () => {
    render(<Button variant="secondary">Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.dataset.slot).toBe("button");
    expect(button.dataset.variant).toBe("secondary");
    expect(button.className).not.toMatch(/t-raise|shadow-/);
    expect(button.className).toMatch(/scale-\[0\.985\]/);
  });

  it("icon sizes are square", () => {
    render(<Button size="icon-sm" aria-label="Close" />);
    expect(screen.getByRole("button", { name: "Close" }).className).toMatch(/size-7/);
  });
});

describe("AlertDialog", () => {
  it("opens from its trigger as an alertdialog with its title and both actions", () => {
    render(
      <AlertDialog>
        <AlertDialogTrigger render={<Button variant="destructive">Delete</Button>} />
        <AlertDialogContent>
          <AlertDialogTitle>Delete the thread?</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive">Delete</AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Delete the thread?");
    expect(dialog.querySelector("[data-slot=dialog-close]")).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });
});

describe("Switch", () => {
  it("is a switch that flips and reports", () => {
    const onChange = vi.fn();
    render(<Switch aria-label="Auto start" onCheckedChange={onChange} />);
    const toggle = screen.getByRole("switch", { name: "Auto start" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("StatusMark", () => {
  const states: ThreadState[] = ["working", "waiting", "paused", "failed", "queued", "stopped", "watching", "done", "idle"];

  it("gives every state one word and one tone", () => {
    for (const state of states) {
      expect(STATUS_WORD[state]).toMatch(/^[A-Z]/);
      expect(STATUS_TONE[state]).toBeTruthy();
    }
    expect(new Set(Object.values(STATUS_WORD)).size).toBe(states.length);
  });

  it("colours only what needs the person", () => {
    expect(STATUS_TONE.waiting).toBe("attention");
    expect(STATUS_TONE.failed).toBe("danger");
    for (const state of states.filter((s) => !statusNeedsYou(s))) {
      expect(["foreground", "muted"]).toContain(STATUS_TONE[state]);
    }
  });

  it("renders the word, or the glyph alone with a label", () => {
    const { rerender } = render(<StatusMark state="queued" />);
    expect(screen.getByText("Queued").dataset.state).toBe("queued");
    rerender(<StatusMark state="queued" word={false} />);
    expect(screen.getByLabelText("Queued").textContent).toBe("");
  });
});

describe("Kbd", () => {
  it("renders a key cap", () => {
    render(<Kbd>⌘</Kbd>);
    expect(document.querySelector("kbd[data-slot=kbd]")?.textContent).toBe("⌘");
  });
});
