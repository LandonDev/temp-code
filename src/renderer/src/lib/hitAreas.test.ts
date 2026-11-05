import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* Hit areas reach 24px and insets sit on the 12px line (docs/DESIGN.md "Spacing"). */
const ROOT = resolve(__dirname, "..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
const STRETCH = "after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']";

describe("hit areas and insets", () => {
  it("stretch the small targets to 24px with an ::after", () => {
    // The task bar's 16px fold: 4px more above and below, so a near miss folds instead of opening the thread.
    expect(read("surfaces/threads/master/MasterRow.tsx")).toContain("relative -mx-1 flex h-4 w-fit max-w-[calc(100%+8px)] items-center gap-2 rounded-sm px-1 after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']");
    // A file tab's 16px close: 4px every side.
    expect(read("chrome/SurfaceTabs.tsx")).toContain("pointer-events-auto relative size-4 rounded-sm text-muted-foreground after:absolute after:-inset-1 after:content-['']");
    // 20px actions: 2px above and below.
    expect(read("chrome/MessageQueue.tsx")).toContain("relative h-5 px-1 text-xs font-normal text-muted-foreground after:absolute after:inset-x-0 after:-inset-y-0.5 after:content-['']");
    expect(read("chrome/ConnectionLine.tsx")).toContain("h-5 px-1.5 text-xs font-normal text-muted-foreground after:absolute after:inset-x-0 after:-inset-y-0.5 after:content-['']");
    // Settings' 16px text links: 4px above and below, nothing around them clipping it.
    expect(read("surfaces/settings/General.tsx")).toContain(`h-auto px-0 text-xs ${STRETCH}`);
    expect(read("surfaces/settings/hosts/Devices.tsx")).toContain(`hover:text-foreground ${STRETCH}`);
    expect(read("chrome/ThreadDefaultsDialog.tsx")).toContain(`h-auto px-0 text-xs ${STRETCH}`);
  });

  it("end the right panel's header on its rows' 12px Stop column, and start a dock tab's label on the terminal's 12px", () => {
    expect(read("surfaces/RightPanel.tsx")).toContain("border-b border-border pr-3 pl-2");
    // The line variant zeroes the list's padding; 8px on that variant plus the trigger's 4px is 12.
    expect(read("chrome/DockBar.tsx")).toContain("data-[variant=line]:px-2");
    expect(read("components/ui/tabs.tsx")).toContain("group-data-[variant=line]/tabs-list:px-1");
    expect(read("index.css")).toMatch(/\.monocode-terminal \{[^}]*padding: 8px 12px;/);
  });
});
