// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LAYER } from "../lib/layers";
import { Modal } from "./Modal";
import { Popover } from "./Popover";

/**
 * A menu opened from inside a dialog sits above it: the add sheet's model
 * picker and the rules dialog's menus are Popovers portalled to the body,
 * so the DOM order alone would put them under the sheet's fixed layer.
 */

afterEach(cleanup);

describe("a popover inside a modal", () => {
  it("takes a z-index above the dialog's layer, and its own layer at the root", () => {
    render(
      <>
        <Popover anchor={{ x: 10, y: 10 }} data-testid="root-menu">
          root
        </Popover>
        <Modal onClose={() => {}} title="Add a thread">
          <Popover anchor={{ x: 20, y: 20 }} data-testid="sheet-menu">
            menu
          </Popover>
        </Modal>
      </>,
    );
    const dialog = screen.getByRole("dialog").closest("[style]") as HTMLElement;
    const dialogZ = Number(dialog.style.zIndex);
    expect(dialogZ).toBe(LAYER.dialog);
    expect(Number(screen.getByTestId("root-menu").style.zIndex)).toBe(LAYER.popover);
    expect(Number(screen.getByTestId("sheet-menu").style.zIndex)).toBeGreaterThan(dialogZ);
  });
});
