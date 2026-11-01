import { describe, expect, it } from "vitest";
import { EDITOR_OPTIONS } from "./monaco";
import { SCROLLBAR_SLIDER_TOKENS, scrollbarSliderColors } from "./theme";

/* Monaco draws its own scrollbar; it takes the app's (docs/DESIGN.md
 * "Scrolling"): a 6px slider in a 10px strip, coloured from the tokens. */
describe("Monaco's scrollbar", () => {
  it("is a 6px slider in a 10px strip with no shadows or ruler border", () => {
    expect(EDITOR_OPTIONS.scrollbar).toMatchObject({
      verticalScrollbarSize: 10,
      horizontalScrollbarSize: 10,
      verticalSliderSize: 6,
      horizontalSliderSize: 6,
      useShadows: false,
    });
    expect(EDITOR_OPTIONS.overviewRulerBorder).toBe(false);
  });

  it("colours its three slider states from the three scrollbar tokens, alpha kept", () => {
    expect(SCROLLBAR_SLIDER_TOKENS).toEqual({
      "scrollbarSlider.background": "--scrollbar-thumb",
      "scrollbarSlider.hoverBackground": "--scrollbar-thumb-hover",
      "scrollbarSlider.activeBackground": "--scrollbar-thumb-active",
    });
    const resolved: Record<string, string> = {
      "--scrollbar-thumb": "#ededed33",
      "--scrollbar-thumb-hover": "#ededed52",
      "--scrollbar-thumb-active": "#ededed66",
    };
    expect(scrollbarSliderColors((token) => resolved[token], "#fallback")).toEqual({
      "scrollbarSlider.background": "#ededed33",
      "scrollbarSlider.hoverBackground": "#ededed52",
      "scrollbarSlider.activeBackground": "#ededed66",
    });
  });

  it("falls back only for a token it cannot resolve", () => {
    const colors = scrollbarSliderColors((token) => (token === "--scrollbar-thumb" ? "#00000033" : undefined), "#ffffff33");
    expect(colors["scrollbarSlider.background"]).toBe("#00000033");
    expect(colors["scrollbarSlider.hoverBackground"]).toBe("#ffffff33");
  });
});
