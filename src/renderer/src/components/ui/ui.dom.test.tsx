// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Button } from "./button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle, AlertDialogTrigger, Dialog, DialogContent, DialogTitle } from "./dialog";
import { Sheet, SheetContent, SheetTitle } from "./sheet";
import { Switch } from "./switch";
import { linkMarkOf, STATUS_TONE, STATUS_WORD, StatusMark, statusNeedsYou, threadStateOf, type ThreadState } from "./status";
import { Kbd } from "./kbd";
import { Skeleton } from "./skeleton";
import { GroupInput, InputGroup } from "./input";
import { Progress } from "./progress";
import { TOOLTIP_CLOSE_DELAY, TOOLTIP_DELAY, Tooltip, TooltipContent, TooltipTrigger, tooltipChunk, warmTooltips } from "./tooltip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";

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

describe("Dialog", () => {
  it("size full fills the window less 24px a side, with no surface of its own and its close button", () => {
    render(
      <Dialog open>
        <DialogContent size="full">
          <DialogTitle>Image</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("data-size")).toBe("full");
    for (const name of ["inset-6", "w-[calc(100vw-48px)]", "h-[calc(100vh-48px)]", "max-w-none", "bg-transparent", "ring-0", "shadow-none"]) {
      expect(dialog.classList.contains(name)).toBe(true);
    }
    expect(dialog.classList.contains("bg-popover")).toBe(false);
    expect(dialog.querySelector("[data-slot=dialog-close]")).toBeTruthy();
  });
});

describe("Sheet", () => {
  it("takes a width in px on a side sheet, and keeps the default without one", () => {
    render(
      <Sheet open>
        <SheetContent side="right" width={672}>
          <SheetTitle>Agent</SheetTitle>
        </SheetContent>
      </Sheet>,
    );
    expect(screen.getByRole("dialog").style.width).toBe("672px");
    cleanup();
    render(
      <Sheet open>
        <SheetContent side="right">
          <SheetTitle>Project</SheetTitle>
        </SheetContent>
      </Sheet>,
    );
    expect(screen.getByRole("dialog").style.width).toBe("");
    expect(screen.getByRole("dialog").className).toContain("w-[440px]");
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
  const states: ThreadState[] = ["working", "waiting", "paused", "failed", "queued", "stopped", "watching", "plan-ready", "done", "idle"];

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

  it("maps every wire status to one state", () => {
    expect(threadStateOf("starting")).toBe("working");
    expect(threadStateOf("running")).toBe("working");
    expect(threadStateOf("waiting")).toBe("waiting");
    expect(threadStateOf("paused")).toBe("paused");
    expect(threadStateOf("error")).toBe("failed");
    expect(threadStateOf("queued")).toBe("queued");
    expect(threadStateOf("stopped")).toBe("stopped");
    expect(threadStateOf("watching")).toBe("watching");
    expect(threadStateOf("done")).toBe("done");
    expect(threadStateOf("idle")).toBe("idle");
    expect(threadStateOf("idle", { settled: true })).toBe("done");
    expect(threadStateOf(undefined)).toBe("idle");
    expect(threadStateOf("idle", { planReady: true })).toBe("plan-ready");
    expect(threadStateOf("done", { planReady: true })).toBe("plan-ready");
    expect(threadStateOf("running", { planReady: true })).toBe("working");
    expect(threadStateOf("waiting", { planReady: true })).toBe("waiting");
    expect(STATUS_TONE["plan-ready"]).toBe("muted");
  });

  it("gives a host link one word per transport, the unreachable one with its time", () => {
    expect(linkMarkOf("open")).toEqual({ state: "done", word: "Connected" });
    expect(linkMarkOf("connecting")).toEqual({ state: "working", word: "Connecting" });
    expect(linkMarkOf("reconnecting")).toEqual({ state: "working", word: "Reconnecting" });
    expect(linkMarkOf("offline")).toEqual({ state: "stopped", word: "Offline" });
    expect(linkMarkOf("unauthorized")).toEqual({ state: "failed", word: "Sign in needed" });
    const since = new Date(2026, 9, 27, 14, 2).getTime();
    const unreachable = linkMarkOf("offline", { unreachableSince: since });
    expect(unreachable.state).toBe("waiting");
    expect(unreachable.word).toMatch(/^Unreachable since \d{1,2}:\d{2}/);
  });

  it("renders the word, the glyph alone with a label, or a given word", () => {
    const { rerender } = render(<StatusMark state="queued" />);
    expect(screen.getByText("Queued").dataset.state).toBe("queued");
    rerender(<StatusMark state="queued" word={false} />);
    expect(screen.getByLabelText("Queued").textContent).toBe("");
    rerender(<StatusMark state="done" word="Connected" />);
    expect(screen.getByText("Connected").dataset.state).toBe("done");
  });

  it("carries a detail after the word, muted", () => {
    render(<StatusMark state="working" detail="typecheck" />);
    const detail = document.querySelector("[data-slot=status-detail]") as HTMLElement;
    expect(detail.textContent).toBe("typecheck");
    expect(detail.className).toContain("text-muted-foreground");
    expect(screen.getByText("Working").textContent).toBe("Workingtypecheck");
  });

  it("a live glyph breathes once on a state change; a settled one is still", () => {
    const { container, rerender } = render(<StatusMark state="watching" />);
    expect(container.querySelector(".status-breathe")).not.toBeNull();
    rerender(<StatusMark state="done" />);
    expect(container.querySelector(".status-breathe")).toBeNull();
  });
});

describe("Skeleton", () => {
  it("is a still block: no sweep class, no animation", () => {
    render(<Skeleton className="h-4 w-24" />);
    const block = document.querySelector("[data-slot=skeleton]") as HTMLElement;
    expect(block.className).toContain("bg-muted");
    expect(block.className).not.toMatch(/shimmer|animate/);
  });
});

describe("InputGroup", () => {
  it("places the glyph before the field and the actions after it", () => {
    render(
      <InputGroup leading={<svg data-testid="glyph" />} trailing={<button type="button">Clear</button>}>
        <GroupInput aria-label="Search" placeholder="Search" />
      </InputGroup>,
    );
    const group = document.querySelector("[data-slot=input-group]") as HTMLElement;
    const order = [...group.querySelectorAll("[data-slot]")].map((n) => n.getAttribute("data-slot"));
    expect(order).toEqual(["input-group-leading", "input", "input-group-trailing"]);
    expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();
    expect(group.className).toContain("focus-field");
    expect((screen.getByLabelText("Search") as HTMLInputElement).className).not.toContain("border");
  });
});

describe("Progress", () => {
  it("fills by a transform in the named colour", () => {
    const { rerender } = render(<Progress value={25} aria-label="room" />);
    const bar = () => document.querySelector("[data-slot=progress-indicator]") as HTMLElement;
    expect(bar().style.transform).toBe("scaleX(0.25)");
    expect(bar().style.width).toBe("100%");
    expect(bar().className).toContain("bg-primary");
    rerender(<Progress value={10} fill="warning" aria-label="room" />);
    expect(bar().style.transform).toBe("scaleX(0.1)");
    expect(bar().className).toContain("bg-warning");
    rerender(<Progress value={50} fill="muted" aria-label="room" />);
    expect(bar().className).toContain("bg-muted-foreground");
  });
});

describe("Tooltip", () => {
  it("is its trigger alone until the primitive loads, then the real tooltip", async () => {
    render(
      <Tooltip>
        <TooltipTrigger render={<button type="button" />}>Save</TooltipTrigger>
        <TooltipContent>Saves the file</TooltipContent>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "Save" });
    expect(tooltipChunk.loaded()).toBeNull();
    expect(trigger.getAttribute("data-slot")).toBeNull();
    await act(async () => {
      fireEvent.pointerEnter(trigger);
      warmTooltips();
      await tooltipChunk.load();
    });
    expect(tooltipChunk.loaded()).not.toBeNull();
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("data-slot")).toBe("tooltip-trigger");
  });
});

describe("Tooltip delays", () => {
  it("are one number each, exported for a hover popover to reuse", () => {
    expect(TOOLTIP_DELAY).toBe(400);
    expect(TOOLTIP_CLOSE_DELAY).toBe(120);
  });
});

describe("Kbd", () => {
  it("renders a key cap", () => {
    render(<Kbd>⌘</Kbd>);
    expect(document.querySelector("kbd[data-slot=kbd]")?.textContent).toBe("⌘");
  });
});

describe("Table", () => {
  it("renders table semantics flat, with no box around it", () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Model</TableHead>
            <TableHead>Effort</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Opus</TableCell>
            <TableCell>High</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getAllByRole("columnheader").map((head) => head.textContent)).toEqual(["Model", "Effort"]);
    expect(screen.getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["Opus", "High"]);
    const container = screen.getByRole("table").parentElement!;
    expect(container.dataset.slot).toBe("table-container");
    expect(container.className).not.toMatch(/border|rounded/);
  });
});
