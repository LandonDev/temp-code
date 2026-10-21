// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { batchExplorerItems, batchMenuExtraItems } from "../lib/threadBatchMenu";
import { ExplorerMenu } from "./ExplorerMenu";
import { TabGroupMenu } from "./TabGroupMenu";

afterEach(cleanup);

const noop = () => {};

describe("the fleet switches as menu rows", () => {
  it("project menu: a row with nothing to act on is inert, a live one picks and closes", () => {
    const onExtraPick = vi.fn();
    const onClose = vi.fn();
    render(
      <TabGroupMenu
        environmentId="local"
        x={10}
        y={10}
        groupId="g"
        label="temp-code"
        colorIndex={null}
        customColor={null}
        currentColor="#888"
        logoPath={null}
        mascotName={null}
        mascotProject="g"
        onRename={noop}
        onColorChange={noop}
        onCustomColorChange={noop}
        onMascotChange={noop}
        onLogoChange={noop}
        onPick={noop}
        onClose={onClose}
        showActions={false}
        extraItems={batchMenuExtraItems({ pause: 3, resume: 0, stop: 3, archiveDone: 0 })}
        onExtraPick={onExtraPick}
      />,
    );
    const resume = screen.getByRole("menuitem", { name: "Resume all" }) as HTMLButtonElement;
    expect(resume.disabled).toBe(true);
    fireEvent.click(resume);
    expect(onExtraPick).not.toHaveBeenCalled();
    const stop = screen.getByRole("menuitem", { name: "Stop all" }) as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    expect(stop.className).toContain("text-danger");
    fireEvent.click(screen.getByRole("menuitem", { name: "Pause all" }));
    expect(onExtraPick).toHaveBeenCalledWith("batch-pause");
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByRole("menuitem", { name: "Archive done" })).toBeTruthy();
  });

  it("host menu: Mark all read first, then the switches, zero rows disabled", () => {
    const onPick = vi.fn();
    render(
      <ExplorerMenu
        x={0}
        y={0}
        ariaLabel="Host actions"
        items={batchExplorerItems({ pause: 0, resume: 2, stop: 0, archiveDone: 1 }, 4)}
        onClose={noop}
        onPick={onPick}
      />,
    );
    const names = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(names).toEqual(["Mark all read", "Pause all", "Resume all", "Stop all", "Archive done"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pause all" }));
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Resume all" }));
    expect(onPick).toHaveBeenCalledWith("batch-resume");
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark all read" }));
    expect(onPick).toHaveBeenCalledWith("read");
  });
});
