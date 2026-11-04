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
import { TOOLTIP_CLOSE_DELAY, TOOLTIP_DELAY, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, resetTooltips, tooltipChunk, warmTooltips } from "./tooltip";
import { TOOLTIP } from "@renderer/lib/ease";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";
import { Item, ItemButton } from "./item";
import { StreamingText } from "./streaming-text";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("@renderer/hooks/paneVisibility", () => ({ usePaneVisible: () => true }));

afterEach(cleanup);

describe("Button", () => {
  it("raises the solid variants on a fill layer, never on the element", () => {
    const raised = { default: "t-raise-primary", secondary: "t-raise-secondary", destructive: "t-raise-destructive" } as const;
    for (const [variant, raise] of Object.entries(raised)) {
      render(<Button variant={variant as keyof typeof raised}>{variant}</Button>);
      const button = screen.getByRole("button", { name: variant });
      expect(button.dataset.slot).toBe("button");
      expect(button.dataset.variant).toBe(variant);
      expect(button.classList).toContain("t-raise");
      expect(button.classList).toContain(raise);
      expect(button.className).not.toMatch(/(^|\s)(hover:)?bg-(primary|secondary|destructive)\b/);
      expect(button.className).not.toMatch(/scale-/);
    }
  });

  it("keeps ghost, outline and link flat: a press steps the fill at once, nothing scales", () => {
    for (const variant of ["ghost", "outline", "link"] as const) {
      render(<Button variant={variant}>{variant}</Button>);
      const button = screen.getByRole("button", { name: variant });
      expect(button.className).not.toMatch(/scale-|t-raise/);
      expect(button.className).toContain("duration-(--dur-hover)");
    }
    for (const variant of ["ghost", "outline"] as const) {
      const classes = screen.getByRole("button", { name: variant }).classList;
      expect(classes).toContain("active:bg-foreground/12");
      expect(classes).toContain("active:transition-none");
      expect(classes).toContain("data-pressed:bg-foreground/12");
    }
  });

  it("lets a row's cancel win over the ghost press", () => {
    render(<Button variant="ghost" className="active:bg-transparent">Row</Button>);
    const classes = screen.getByRole("button", { name: "Row" }).classList;
    expect(classes).toContain("active:bg-transparent");
    expect(classes).not.toContain("active:bg-foreground/12");
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
  it("enters on keyframes from its edge, fading alone under reduced motion", () => {
    render(
      <Sheet open>
        <SheetContent side="right">
          <SheetTitle>Project</SheetTitle>
        </SheetContent>
      </Sheet>,
    );
    const classes = screen.getByRole("dialog").className.split(/\s+/);
    for (const c of [
      "data-open:animate-in",
      "data-open:fade-in-0",
      "duration-(--dur-drawer)",
      "ease-(--ease-drawer)",
      "data-closed:animate-out",
      "data-closed:duration-(--dur-slow)",
      "motion-safe:data-[side=right]:data-open:slide-in-from-right-4",
      "motion-safe:data-[side=right]:data-closed:slide-out-to-right-4",
    ])
      expect(classes).toContain(c);
    // Every slide is motion-safe, so reduced motion keeps only the fade.
    expect(classes.filter((c) => c.includes("slide-") && !c.startsWith("motion-safe:"))).toEqual([]);
    expect(classes.some((c) => c.includes("starting-style"))).toBe(false);
  });

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
    expect(screen.getByText("Queued").closest("[data-slot=status-mark]")?.getAttribute("data-state")).toBe("queued");
    rerender(<StatusMark state="queued" word={false} />);
    expect(screen.getByLabelText("Queued").textContent).toBe("");
    rerender(<StatusMark state="done" word="Connected" />);
    expect(screen.getByText("Connected").closest("[data-slot=status-mark]")?.getAttribute("data-state")).toBe("done");
  });

  it("draws every glyph in one 14px box, 8px from the word, so a change of state never moves it", () => {
    const { rerender } = render(<StatusMark state="working" />);
    const box = () => document.querySelector("[data-slot=status-glyph]") as HTMLElement;
    for (const state of ["working", "stopped", "done", "waiting"] as const) {
      rerender(<StatusMark state={state} />);
      expect(box().className).toContain("size-3.5");
      expect(box().className).toContain("place-items-center");
    }
    // The spinner and the square stay 12px inside the box.
    rerender(<StatusMark state="stopped" />);
    expect(box().querySelector("svg")?.getAttribute("class")).toContain("size-3");
    expect((document.querySelector("[data-slot=status-mark]") as HTMLElement).className).toContain("gap-2");
  });

  it("carries a detail after the word, muted", () => {
    render(<StatusMark state="working" detail="typecheck" />);
    const detail = document.querySelector("[data-slot=status-detail]") as HTMLElement;
    expect(detail.textContent).toBe("typecheck");
    expect(detail.className).toContain("text-muted-foreground");
    expect(screen.getByText("Working").closest("[data-slot=status-mark]")?.textContent).toBe("Workingtypecheck");
  });

  it("draws the word in medium weight and the detail regular and muted, with the colon form as the label of a glyph alone", () => {
    const { rerender } = render(<StatusMark state="queued" detail="Waiting for memory" />);
    expect(document.querySelector("[data-slot=status-word]")?.className).toContain("font-medium");
    expect(document.querySelector("[data-slot=status-detail]")?.className).toContain("font-normal");
    rerender(<StatusMark state="queued" word={false} detail="Waiting for memory" />);
    expect(screen.getByLabelText("Queued: Waiting for memory")).toBeTruthy();
  });

  it("still draws working's arc without its turn or its breath", () => {
    const { container, rerender } = render(<StatusMark state="working" still />);
    const turns = () => (container.querySelector("[data-slot=spinner]") as SVGElement).hasAttribute("data-turning");
    expect(turns()).toBe(false);
    expect(container.querySelector(".status-breathe")).toBeNull();
    rerender(<StatusMark state="working" />);
    expect(turns()).toBe(true);
  });

  it("glyph={false} draws the word alone", () => {
    const { container } = render(<StatusMark state="failed" glyph={false} detail="Usage cap" />);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toBe("FailedUsage cap");
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
    expect(block.className).not.toMatch(/pulse|animate/);
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
  it("does not swap under a focused field, even across a re-render, until focus leaves", async () => {
    resetTooltips();
    function Row({ title }: { title: string }) {
      return (
        <Tooltip>
          <TooltipTrigger render={<span />}>
            <input aria-label="Rename" defaultValue={title} />
          </TooltipTrigger>
          <TooltipContent>Rename the thread</TooltipContent>
        </Tooltip>
      );
    }
    const { rerender } = render(<Row title="a" />);
    const field = screen.getByLabelText("Rename") as HTMLInputElement;
    field.focus();
    fireEvent.change(field, { target: { value: "typed" } });
    await act(async () => {
      warmTooltips();
      await tooltipChunk.load();
    });
    rerender(<Row title="b" />);
    expect(screen.getByLabelText("Rename")).toBe(field);
    expect(field.value).toBe("typed");
    await act(async () => {
      field.blur();
      fireEvent.focusOut(field);
      await Promise.resolve();
    });
    expect(screen.getByLabelText("Rename").closest("[data-slot=tooltip-trigger]")).not.toBeNull();
  });

  it("is its trigger alone until the primitive loads, then the real tooltip", async () => {
    resetTooltips();
    render(
      <Tooltip>
        <TooltipTrigger render={<button type="button" />}>Save</TooltipTrigger>
        <TooltipContent>Saves the file</TooltipContent>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "Save" });
    expect(trigger.getAttribute("data-slot")).toBeNull();
    await act(async () => {
      fireEvent.pointerEnter(trigger);
      warmTooltips();
      await tooltipChunk.load();
    });
    expect(tooltipChunk.loaded()).not.toBeNull();
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("data-slot")).toBe("tooltip-trigger");
  });

  it("never swaps a trigger between its press and its click: the first click on a cold one lands", async () => {
    await tooltipChunk.load();
    resetTooltips();
    const onClick = vi.fn();
    render(
      <Tooltip>
        <TooltipTrigger render={<button type="button" onClick={onClick} />}>Settings</TooltipTrigger>
        <TooltipContent>Settings</TooltipContent>
      </Tooltip>,
    );
    const button = screen.getByRole("button", { name: "Settings" });
    await act(async () => {
      fireEvent.pointerEnter(button);
      fireEvent.pointerDown(button);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.getByRole("button", { name: "Settings" })).toBe(button);
      fireEvent.pointerUp(button);
      fireEvent.click(button);
    });
    expect(onClick).toHaveBeenCalledOnce();
    expect(button.isConnected).toBe(true);
    // Released, the tooltip warms.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("data-slot")).toBe("tooltip-trigger");
  });
});

describe("Tooltip popup", () => {
  it("is 13px regular on 20px lines, 24px tall, and enters from 0.98 on the drawer curve", async () => {
    await act(async () => {
      warmTooltips();
      await tooltipChunk.load();
    });
    render(
      <Tooltip open>
        <TooltipTrigger render={<button type="button" />}>Target</TooltipTrigger>
        <TooltipContent>Label</TooltipContent>
      </Tooltip>,
    );
    const label = await screen.findByText("Label");
    const popup = label.closest("[data-slot]") as HTMLElement;
    for (const name of ["text-[13px]", "leading-5", "font-normal", "min-h-6", "py-0.5", "duration-(--dur-fast)", "ease-(--ease-drawer)", "data-starting-style:scale-[0.98]"]) {
      expect(popup.className).toContain(name);
    }
    expect(popup.className).not.toContain("font-medium");
    // Tailwind's scale-* sets `scale`, so that is the property the popup transitions.
    expect(popup.className).toContain("transition-[scale,opacity]");
    expect(popup.className).toContain("motion-reduce:transition-[opacity]");
    expect(popup.className).not.toMatch(/transition-\[transform|motion-reduce:transition-none/);
  });
});

describe("Tooltip neighbours", () => {
  const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
  const hover = (el: Element) => {
    fireEvent.pointerEnter(el, { pointerType: "mouse" });
    fireEvent.mouseEnter(el);
    fireEvent.mouseMove(el);
  };
  const leave = (el: Element) => {
    fireEvent.pointerLeave(el, { pointerType: "mouse" });
    fireEvent.mouseLeave(el);
  };

  it("inside one provider, the second label opens without another wait", async () => {
    await act(async () => {
      warmTooltips();
      await tooltipChunk.load();
    });
    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger render={<button type="button" />}>Copy</TooltipTrigger>
          <TooltipContent>Copy the turn</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<button type="button" />}>Note</TooltipTrigger>
          <TooltipContent>Save as a note</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    hover(screen.getByRole("button", { name: "Copy" }));
    await wait(TOOLTIP.delay + 60);
    expect(screen.queryByText("Copy the turn")).not.toBeNull();
    leave(screen.getByRole("button", { name: "Copy" }));
    hover(screen.getByRole("button", { name: "Note" }));
    await wait(40);
    expect(screen.queryByText("Save as a note")).not.toBeNull();
  });

  it("the delays are TOOLTIP's, re-exported", () => {
    expect(TOOLTIP_DELAY).toBe(TOOLTIP.delay);
    expect(TOOLTIP_CLOSE_DELAY).toBe(TOOLTIP.closeDelay);
  });
});

describe("Tooltip delays", () => {
  it("are one number each, exported for a hover popover to reuse", () => {
    expect(TOOLTIP_DELAY).toBe(300);
    expect(TOOLTIP_CLOSE_DELAY).toBe(120);
  });
});

describe("ItemButton", () => {
  it("is one button that reads as an Item row, and acts on a click", () => {
    const onClick = vi.fn();
    render(
      <>
        <Item size="xs">row</Item>
        <ItemButton size="xs" onClick={onClick}>
          open
        </ItemButton>
      </>,
    );
    const button = screen.getByRole("button", { name: "open" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("data-slot")).toBe("item");
    expect(button.getAttribute("data-size")).toBe("xs");
    const row = screen.getByText("row");
    for (const name of row.className.split(" ")) expect(button.className).toContain(name);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
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

describe("StreamingText", () => {
  it("draws the line as one fading span, and each update's new text as one more", () => {
    const view = render(<StreamingText className="truncate">{"Reading  the"}</StreamingText>);
    const line = view.container.firstElementChild as HTMLElement;
    expect(line.className).toBe("truncate");
    const steps = () => Array.from(line.querySelectorAll(".stream-step"));
    expect(steps().map((step) => step.textContent)).toEqual(["Reading  the"]);
    const first = steps()[0];
    view.rerender(<StreamingText className="truncate">{"Reading  the\nfile."}</StreamingText>);
    expect(steps().map((step) => step.textContent)).toEqual(["Reading  the", "\nfile."]);
    expect(steps()[0]).toBe(first);
    expect(line.textContent).toBe("Reading  the\nfile.");
    view.rerender(<StreamingText className="truncate">{"Something else"}</StreamingText>);
    expect(steps().map((step) => step.textContent)).toEqual(["Something else"]);
  });

  it("fades on the reveal tokens and stops under reduced motion", () => {
    const css = readFileSync(resolve(__dirname, "../../assets/components.css"), "utf8");
    expect(css).toMatch(/\.stream-step\s*\{\s*animation:\s*stream-step-in var\(--dur-reveal\) var\(--ease-reveal\) both;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.stream-step\s*\{\s*animation:\s*none;/);
  });
});
