// @vitest-environment jsdom
/** A width taken in a fallback face is dropped once the fonts load, so a
 *  re-measure on `document.fonts.ready` reads the real face. */
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("forgets cached widths when the fonts are ready", async () => {
  let perChar = 5;
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      getContext() {
        return { font: "", measureText: (text: string) => ({ width: text.length * perChar }) };
      }
    },
  );
  let loaded!: () => void;
  const ready = new Promise<void>((resolve) => (loaded = resolve));
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready } });
  const { canvasMeasure } = await import("./taskListWidth");
  const measure = canvasMeasure({ label: "12px sans", time: "12px sans" })!;
  expect(measure("abcd", "label")).toBe(20);
  perChar = 6;
  expect(measure("abcd", "label")).toBe(20);
  loaded();
  await ready;
  await Promise.resolve();
  expect(measure("abcd", "label")).toBe(24);
});
