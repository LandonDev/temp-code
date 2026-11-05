import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { reveal } from "../components/ui/reveal";

/* UI-19's details on the thread views and pages, read from the source where a
   render needs a host, a store or a layout jsdom does not have. */
const read = (file: string) => readFileSync(resolve(__dirname, "..", file), "utf8");

describe("thread views and pages", () => {
  it("hover reveals wait --delay-hover, show at once on focus or an open menu, and keep their fade under reduced motion", () => {
    // Both rows take the one recipe (components/ui/reveal.ts) rather than a class string of their own.
    const calls = {
      "surfaces/threads/master/MasterRow.tsx": ['reveal("", { row: true, overlay: true })', reveal("", { row: true, overlay: true })],
      "surfaces/settings/Archive.tsx": ['reveal("item", { row: true })', reveal("item", { row: true })],
    } as const;
    for (const [file, [call, classes]] of Object.entries(calls)) {
      const text = read(file);
      expect(text, file).toContain(call);
      expect(text, file).not.toMatch(/className="[^"]*opacity-0 transition-opacity/);
      for (const cls of ["delay-(--delay-hover)", "delay-(--dur-instant)", "ease-(--ease-out)", "motion-reduce:transition-", "has-[[data-popup-open]]:opacity-100"]) {
        expect(classes, `${file} ${cls}`).toContain(cls);
      }
      expect(classes, file).not.toContain("motion-reduce:transition-none");
    }
  });

  it("ThreadTune draws no inset of its own; its callers give it theirs", () => {
    const tune = read("chrome/ThreadTune.tsx");
    expect(tune).toContain('<div className="flex flex-col gap-4">');
    expect(tune).not.toContain("px-5 py-3");
    expect(tune).toContain("<ModalBody>");
    expect(tune).toContain('<DialogFooter onCancel={onCancel} confirmLabel="Save"');
    expect(read("surfaces/threads/StartBuildDialog.tsx")).not.toContain("-mx-4 -my-3");
    const chooser = read("chrome/NewThreadChooser.tsx");
    expect(chooser).toContain('<div className="flex items-center gap-1 px-2 pt-2">');
    expect(chooser).toContain('<div className="px-2 py-3">');
    expect(chooser).toContain('<div className="flex justify-end px-2 pb-2">');
  });

  it("the inbox's and the notes' sashes take the keyboard through useSashKeys", () => {
    for (const file of ["surfaces/InboxView.tsx", "surfaces/NotesView.tsx"]) {
      const text = read(file);
      expect(text, file).toContain("useSashKeys({");
      expect(text, file).toContain("{...sashKeys}");
      expect(text, file).toContain('resize.dragging ? "bg-foreground/12" : "hover:bg-foreground/7"');
    }
  });

  it("Search says no results through EmptyState, with Clear filters when filters narrowed it", () => {
    const text = read("surfaces/SearchView.tsx");
    expect(text).toContain('<EmptyState\n            title="No results"');
    expect(text).toContain('action={filtered ? { label: "Clear filters", onClick: clearFilters } : undefined}');
  });

  it("lists sit 4px in with 8px rows, so their text lands 12px in", () => {
    for (const file of ["surfaces/InboxView.tsx", "surfaces/NotesView.tsx"]) {
      const text = read(file);
      expect(text, file).not.toContain('<ul className="flex flex-col gap-0.5 p-1.5">');
      expect(text, file).not.toContain("rounded-md px-2.5 py-2");
    }
  });

  it("small type is on the scale: 12px, never 10 or 11 outside a key cap", () => {
    for (const file of ["surfaces/InboxPrDiff.tsx", "surfaces/InboxComments.tsx", "surfaces/threads/master/RulesDialog.tsx"]) {
      expect(read(file), file).not.toMatch(/text-\[10px\]/);
    }
    expect(read("surfaces/threads/master/RulesDialog.tsx")).not.toContain("text-end text-[11px]");
  });
});
