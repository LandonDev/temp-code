// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LAYER } from "../lib/layers";
import { Modal } from "./Modal";
import { Popover } from "./Popover";

/**
 * A menu opened from inside a dialog sits above it: the add sheet's model
 * picker and the rules dialog's menus are Popovers portalled to the body,
 * and the popover layer outranks the dialog's at the root and inside one.
 */

afterEach(cleanup);

describe("a popover inside a modal", () => {
  it("takes the popover layer, above the dialog's", () => {
    render(
      <Modal onClose={() => {}} title="Add a thread">
        <Popover anchor={{ x: 20, y: 20 }} data-testid="sheet-menu">
          menu
        </Popover>
      </Modal>,
    );
    expect(screen.getByRole("dialog").className).toContain("z-(--layer-dialog)");
    expect(Number(screen.getByTestId("sheet-menu").style.zIndex)).toBe(LAYER.popover);
    expect(LAYER.popover).toBeGreaterThan(LAYER.dialog);
  });
});
