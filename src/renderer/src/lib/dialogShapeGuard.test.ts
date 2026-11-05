import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * One dialog shape (docs/DESIGN.md "Panels, modals…"): a form dialog is
 * Modal (or ModalPanel in a Dialog its parent holds open), ModalBody and
 * ConfirmDialog's DialogFooter. A bare DialogContent, or ui/dialog's own
 * DialogFooter, is a second shape (no hairline, a 384px panel, a footer at
 * another inset); only the shells and the full-window viewers draw one.
 */
const ROOT = resolve(__dirname, "..");
const SHELLS = new Set([
  "chrome/Modal.tsx", // the shape itself
  "chrome/PickerDialog.tsx", // ⌘P and ⌘⇧O: a list with no footer
  "chrome/Lightbox.tsx", // full-window image viewer
  "surfaces/HtmlRenderViewer.tsx", // full-window page viewer
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "components" ? [] : files(path);
    return /\.tsx$/.test(name) && !/\.(test|fixtures)\.tsx$/.test(name) ? [path] : [];
  });
}

const fromUiDialog = /import\s*\{([^}]*)\}\s*from\s*["'][^"']*components\/ui\/dialog["']/g;

describe("the dialog shape guard", () => {
  it("draws DialogContent and ui/dialog's DialogFooter only in the shells", () => {
    const offenders: string[] = [];
    for (const path of files(ROOT)) {
      const rel = relative(ROOT, path);
      if (SHELLS.has(rel)) continue;
      for (const match of readFileSync(path, "utf8").matchAll(fromUiDialog)) {
        const names = match[1].split(",").map((n) => n.trim().split(/\s+as\s+/)[0]);
        for (const name of ["DialogContent", "DialogFooter", "DialogHeader"]) if (names.includes(name)) offenders.push(`${rel}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("catches a bare form dialog", () => {
    const text = 'import { Dialog, DialogContent, DialogFooter } from "../components/ui/dialog";';
    const names = [...text.matchAll(fromUiDialog)].flatMap((m) => m[1].split(",").map((n) => n.trim()));
    expect(names).toContain("DialogContent");
  });
});
