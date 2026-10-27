import { afterEach, describe, expect, it, vi } from "vitest";
import { mountProbe } from "../test/renderProbe";
import { ConflictBar } from "./ConflictBar";

describe("ConflictBar", () => {
  let probe: ReturnType<typeof mountProbe> | null = null;
  afterEach(() => {
    probe?.unmount();
    probe = null;
  });

  const alert = () => probe!.container.querySelector<HTMLElement>('[data-slot="alert"]')!;
  const button = (name: string) =>
    [...probe!.container.querySelectorAll("button")].find((b) => b.textContent === name) ?? null;

  it("interrupts with the change on disk and offers Reload and Keep mine", () => {
    const onReload = vi.fn();
    const onKeep = vi.fn();
    probe = mountProbe(<ConflictBar kind="external" onReload={onReload} onKeep={onKeep} />);
    expect(alert().getAttribute("role")).toBe("alert");
    expect(alert().className).toContain("bg-warning/10");
    expect(probe.container.textContent).toContain("Changed on disk where you were editing");
    expect(probe.container.textContent).not.toContain("·");
    expect(probe.container.querySelector("[title]")).toBeNull();
    expect(probe.container.querySelectorAll("button")).toHaveLength(2);
    button("Reload")!.click();
    expect(onReload).toHaveBeenCalledTimes(1);
    button("Keep mine")!.click();
    expect(onKeep).toHaveBeenCalledTimes(1);
  });

  it("offers Restore alone for a deleted file", () => {
    const onReload = vi.fn();
    const onKeep = vi.fn();
    probe = mountProbe(<ConflictBar kind="deleted" onReload={onReload} onKeep={onKeep} />);
    expect(alert().getAttribute("role")).toBe("alert");
    expect(probe.container.textContent).toContain("Deleted on disk");
    expect(probe.container.querySelectorAll("button")).toHaveLength(1);
    expect(button("Reload")).toBeNull();
    button("Restore")!.click();
    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onReload).not.toHaveBeenCalled();
  });

  it("wraps the message instead of cutting it, with the actions kept together at the end", () => {
    probe = mountProbe(<ConflictBar kind="external" onReload={vi.fn()} onKeep={vi.fn()} />);
    const message = [...probe.container.querySelectorAll("span")].find((span) =>
      span.textContent?.startsWith("Changed on disk"),
    )!;
    expect(message.textContent).toBe("Changed on disk where you were editing");
    expect(message.className).not.toContain("truncate");
    expect(message.parentElement!.className).toContain("flex-wrap");
    const end = probe.container.querySelector<HTMLElement>("[data-alert-end]")!;
    expect(end.className).toContain("ms-auto");
    expect(end.className).toContain("shrink-0");
    expect(end.querySelectorAll("button")).toHaveLength(2);
  });
});
