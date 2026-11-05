// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MasterCheck } from "./MasterCheck";

afterEach(cleanup);

describe("MasterCheck", () => {
  it("is a row control like the draft row's pickers: hover /5 over --dur-hover, press /12, reduced motion still", () => {
    const { container } = render(<MasterCheck checked={false} onChange={() => {}} />);
    const label = container.querySelector<HTMLElement>("[data-composer-master]")!;
    for (const c of ["hover:bg-foreground/5", "duration-(--dur-hover)", "ease-(--ease-out)", "active:bg-foreground/12", "motion-reduce:transition-none"])
      expect(label.className).toContain(c);
    expect(label.className).not.toMatch(/duration-\(--dur-fast\)|hover:bg-foreground\/7/);
  });

  it("ticks through the cold box", () => {
    const onChange = vi.fn();
    const { getByRole } = render(<MasterCheck checked={false} onChange={onChange} />);
    fireEvent.click(getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
