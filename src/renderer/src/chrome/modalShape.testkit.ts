import { expect } from "vitest";

/**
 * The one dialog shape (docs/DESIGN.md "Panels, modals…"): a Modal panel
 * with its header, title and close, and a DialogFooter with a hairline,
 * Cancel as the secondary button, and the verb last. Tests of each form
 * dialog call it on the open panel.
 */
export function expectModalShape(panel: Element, { cancel = true }: { cancel?: boolean } = {}): void {
  expect(panel.getAttribute("data-slot")).toBe("dialog-content");
  const header = panel.querySelector(":scope > header");
  expect(header, "the Modal's header").not.toBeNull();
  expect(header!.querySelector('[data-slot="dialog-title"]')).not.toBeNull();
  expect(header!.querySelector('[aria-label="Close"]')).not.toBeNull();
  const footer = panel.querySelector('[data-slot="dialog-footer"]');
  expect(footer, "a DialogFooter").not.toBeNull();
  expect(footer!.className).toContain("border-t");
  expect(footer!.className).toContain("pb-5");
  const buttons = [...footer!.querySelectorAll(":scope > button")];
  expect(buttons.at(-1)!.hasAttribute("data-dialog-confirm")).toBe(true);
  const cancelButton = footer!.querySelector("[data-dialog-cancel]");
  if (cancel) {
    expect(cancelButton, "Cancel").not.toBeNull();
    expect(cancelButton!.getAttribute("data-variant")).toBe("secondary");
  } else expect(cancelButton).toBeNull();
}
