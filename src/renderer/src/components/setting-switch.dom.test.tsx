// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@renderer/lib/sounds", () => ({ playCue: () => {} }));

import { SettingSwitch } from "./setting-switch";

afterEach(cleanup);

const checked = () => screen.getByRole("switch", { name: "Memory" }).getAttribute("aria-checked");

describe("SettingSwitch", () => {
  it("moves the thumb on the click, before the host answers, and takes the host's value once it lands", async () => {
    let land: () => void = () => {};
    function Host() {
      const [on, setOn] = useState(false);
      return <SettingSwitch label="Memory" on={on} onChange={(next) => new Promise<void>((done) => (land = () => (setOn(next), done())))} />;
    }
    render(<Host />);
    fireEvent.click(screen.getByRole("switch", { name: "Memory" }));
    expect(checked()).toBe("true");
    await act(async () => land());
    expect(checked()).toBe("true");
  });

  it("slides back when the change is refused or did not land", async () => {
    let refuse: () => void = () => {};
    const { rerender } = render(<SettingSwitch label="Memory" on={false} onChange={() => new Promise((_, reject) => (refuse = () => reject(new Error("offline"))))} />);
    fireEvent.click(screen.getByRole("switch", { name: "Memory" }));
    expect(checked()).toBe("true");
    await act(async () => refuse());
    expect(checked()).toBe("false");
    rerender(<SettingSwitch label="Memory" on={false} onChange={() => Promise.resolve(false)} />);
    fireEvent.click(screen.getByRole("switch", { name: "Memory" }));
    await act(async () => {});
    expect(checked()).toBe("false");
  });
});
