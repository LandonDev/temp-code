// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { HostDevicesReport } from "@server/shared/contract-hostdevices";

vi.mock("../../../lib/hostDevices", () => ({}));

const { DevicesBlock } = await import("./Devices");
type Props = Parameters<typeof DevicesBlock>[0];

/**
 * The devices group in a Mac's section: the summary at the heading, a row
 * per simulator and phone with its state words and holder, the actions, the
 * delete confirm, the empty line and the skeleton before the first report.
 */

const host = { environmentId: "env_mac", name: "Landon’s Mac", local: true };

const report = (over: Partial<HostDevicesReport> = {}): HostDevicesReport => ({
  environmentId: "env_mac",
  at: 1,
  simulators: [
    {
      udid: "AAA",
      name: "iPhone 17 Pro",
      runtime: "iOS 27.0",
      state: "booted",
      cpu: 12.4,
      holder: { sessionId: "s1", title: "iOS: Home", status: "running" },
    },
    { udid: "BBB", name: "iPad Pro 13-inch (M4)", runtime: "iOS 27.0", state: "shutdown", holder: null },
  ],
  phones: [{ udid: "P1", name: "Landon’s iPhone", model: "iPhone 17 Pro Max", os: "iOS 27.2", connection: "connected", transport: "USB", holder: null }],
  xcode: { path: "/Applications/Xcode-beta.app", name: "Xcode-beta", version: "27.0", from: "newest" },
  load: { oneMinute: 2.1, cores: 10 },
  problems: [],
  ...over,
});

function mount(over: Partial<Props> = {}) {
  const props: Props = {
    host,
    report: report(),
    error: null,
    onShutdown: vi.fn(async () => {}),
    onDelete: vi.fn(async () => {}),
    onOpenXcode: vi.fn(async () => {}),
    onOpenSession: vi.fn(),
    ...over,
  };
  const view = render(<DevicesBlock {...props} />);
  return { props, root: view.container };
}
const facts = (el: Element | null) => [...(el?.querySelectorAll("[data-slot=facts] > span") ?? [])].map((s) => s.textContent);
const rows = (root: Element) => [...root.querySelectorAll("[data-device]")];

afterEach(cleanup);

describe("DevicesBlock", () => {
  it("the summary at the heading, one row per device with its state words and holder", () => {
    const { root } = mount();
    // The rows say how many simulators there are, the Load limit row says the load: the heading keeps the phone and Xcode.
    expect(facts(root.querySelector("[data-summary]"))).toEqual(["iPhone 17 Pro Max connected", "Xcode-beta 27.0"]);
    const [sim, ipad, phone] = rows(root);
    expect(sim!.textContent).toContain("iPhone 17 Pro");
    expect(sim!.textContent).toContain("iOS 27.0");
    expect(facts(sim!).slice(-2)).toEqual(["Booted", "12% CPU"]);
    expect(sim!.querySelector("[data-slot=item-description] [data-holder]")).not.toBeNull();
    expect(sim!.querySelector("[data-holder]")!.textContent).toBe("iOS: Home, running");
    expect(facts(ipad!)).toEqual(["Shutdown"]);
    expect(ipad!.querySelector("[data-holder]")).toBeNull();
    expect(facts(phone!)).toEqual(["Landon’s iPhone", "iOS 27.2", "Connected", "USB"]);
    expect(root.textContent).not.toContain("·");
  });

  it("a linked Mac keeps its load in the heading: it has no Load limit row on this page", () => {
    const { root } = mount({ host: { ...host, local: false } });
    expect(facts(root.querySelector("[data-summary]"))).toEqual(["iPhone 17 Pro Max connected", "load 2.1 / 10 cores", "Xcode-beta 27.0"]);
  });

  it("the holder links to its thread", () => {
    const { props } = mount();
    fireEvent.click(screen.getByRole("button", { name: "iOS: Home, running" }));
    expect(props.onOpenSession).toHaveBeenCalledWith("s1");
  });

  it("Shutdown shows on a booted simulator only; Open in Xcode on a phone", async () => {
    const { props } = mount();
    expect(screen.getAllByRole("button", { name: "Shutdown" }).length).toBe(1);
    expect(screen.getAllByRole("button", { name: "Delete" }).length).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Shutdown" }));
    expect(props.onShutdown).toHaveBeenCalledWith("AAA");
    // While one action runs every other is disabled; once it settles they come back.
    expect((screen.getByRole("button", { name: "Open in Xcode" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Open in Xcode" }));
    expect(props.onOpenXcode).toHaveBeenCalled();
  });

  it("Delete asks first, naming the thread that holds the simulator, and deletes on confirm", async () => {
    const { props } = mount();
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]!);
    expect(screen.getByText("Held by iOS: Home, running. Delete anyway?")).toBeTruthy();
    expect(props.onDelete).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Delete" }).at(-1)!);
    });
    expect(props.onDelete).toHaveBeenCalledTimes(1);
    expect(props.onDelete).toHaveBeenCalledWith("AAA");
  });

  it("a simulator nobody holds confirms with what is removed", () => {
    mount();
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]!);
    expect(screen.getByText("iPad Pro 13-inch (M4) (iOS 27.0) and its data are removed from this Mac.")).toBeTruthy();
  });

  it("the empty state is one muted line", () => {
    const { root } = mount({ report: report({ simulators: [], phones: [] }) });
    expect(root.querySelector("[data-empty]")!.textContent).toBe("No simulators");
    expect(rows(root)).toHaveLength(0);
    expect(facts(root.querySelector("[data-summary]"))).toEqual(["Xcode-beta 27.0"]);
  });

  it("a phone with no simulator still gets its row, with the muted line in place of the simulators", () => {
    const { root } = mount({ report: report({ simulators: [] }) });
    expect(root.querySelector("[data-empty]")!.textContent).toBe("No simulators");
    expect(rows(root)).toHaveLength(1);
  });

  it("before the first report: skeleton rows; a failure with no report shows it", () => {
    const { root } = mount({ report: null });
    expect(root.querySelector("[data-looking]")).not.toBeNull();
    expect(root.querySelectorAll("[data-slot=skeleton]")).toHaveLength(2);
    cleanup();
    const failed = mount({ report: null, error: "Landon’s Mac is not linked right now" });
    expect(failed.root.textContent).toContain("Landon’s Mac is not linked right now");
    expect(failed.root.querySelector("[data-summary]")!.textContent).toBe("Not reachable");
  });
});
