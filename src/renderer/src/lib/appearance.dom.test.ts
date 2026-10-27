// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyThemePreference,
  EDITOR_FONT_CHANGE_EVENT,
  EDITOR_FONT_SIZE_DEFAULT,
  editorFontOptions,
  initAppearance,
  loadEditorFontSize,
  saveEditorFontSize,
} from "./appearance";

const root = document.documentElement;

beforeEach(() => {
  localStorage.clear();
  root.className = "";
  root.removeAttribute("style");
});
afterEach(() => vi.restoreAllMocks());

describe("editor font size", () => {
  it("defaults to 13px", () => {
    expect(EDITOR_FONT_SIZE_DEFAULT).toBe(13);
    expect(loadEditorFontSize()).toBe(13);
  });

  it("saves, loads and clamps to the list", () => {
    expect(saveEditorFontSize(14)).toBe(14);
    expect(loadEditorFontSize()).toBe(14);
    expect(saveEditorFontSize(40)).toBe(14);
    expect(saveEditorFontSize(3)).toBe(12);
    localStorage.setItem("monocode.editorFontSize", "15");
    expect(loadEditorFontSize()).toBe(13);
  });

  it("sets the code size variable and tells the editors", () => {
    const heard = vi.fn();
    window.addEventListener(EDITOR_FONT_CHANGE_EVENT, heard);
    saveEditorFontSize(12);
    window.removeEventListener(EDITOR_FONT_CHANGE_EVENT, heard);
    expect(root.style.getPropertyValue("--font-size-code")).toBe("12px");
    expect((heard.mock.calls[0][0] as CustomEvent).detail).toBe(12);
  });

  it("gives Monaco a line height for each size", () => {
    expect(editorFontOptions(12)).toEqual({ fontSize: 12, lineHeight: 18 });
    expect(editorFontOptions(13)).toEqual({ fontSize: 13, lineHeight: 20 });
    expect(editorFontOptions(14)).toEqual({ fontSize: 14, lineHeight: 22 });
  });
});

describe("initAppearance", () => {
  it("clears the retired keys and applies the font size", () => {
    for (const key of [
      "themeHue",
      "themeSaturation",
      "sidebarOpacity",
      "bodyGlass",
      "glass",
      "sidebarLayout",
      "sidebarOpen",
      "sidebarTabOrder",
      "transcriptLayout",
      "transcriptZen",
    ]) {
      localStorage.setItem(`monocode.${key}`, "1");
    }
    localStorage.setItem("monocode.colorScheme", "dark");
    localStorage.setItem("monocode.editorFontSize", "14");
    initAppearance();
    expect(Object.keys(localStorage).sort()).toEqual(["monocode.colorScheme", "monocode.editorFontSize"]);
    expect(root.style.getPropertyValue("--font-size-code")).toBe("14px");
    expect(root.classList.contains("glass")).toBe(false);
  });

  it("keeps no sidebar layout setting: no key is read and none is exported", async () => {
    const appearance = await import("./appearance");
    for (const name of ["loadSidebarLayout", "saveSidebarLayout", "SIDEBAR_LAYOUT_DEFAULT", "LAYOUT_CHANGE_EVENT"]) {
      expect(name in appearance).toBe(false);
    }
  });
});

describe("theme flip", () => {
  it("turns transitions off for one frame", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    applyThemePreference("light");
    expect(root.classList.contains("theme-light")).toBe(true);
    expect(root.classList.contains("theme-switching")).toBe(true);
    frames.forEach((cb) => cb(0));
    expect(root.classList.contains("theme-switching")).toBe(false);
  });

  it("leaves transitions alone when the scheme does not change", () => {
    applyThemePreference("dark");
    expect(root.classList.contains("theme-switching")).toBe(false);
  });
});
