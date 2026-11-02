import { StrictMode } from "react";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountProbe } from "../test/renderProbe";
import { useToastSync, type ToastApi } from "./toastSync";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { warning: vi.fn(), dismiss: vi.fn() }));
const loader = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast }));
vi.mock("../components/ui/toaster", async () => {
  const { toast } = await import("sonner");
  return { loadToast: () => loader().then(() => toast) };
});

type Item = { id: string; title: string };
function Owner({ items, secondary = false }: { items: Item[]; secondary?: boolean }) {
  useToastSync(items, (item) => item.id, (api: ToastApi, item, id) => {
    api.warning(item.title, { id });
    if (!secondary) return;
    api.warning("More", { id: `${id}:more` });
    return () => { api.dismiss(`${id}:more`); };
  }, (item) => item.title);
  return null;
}

let probe: ReturnType<typeof mountProbe> | null = null;
beforeEach(() => {
  loader.mockReset().mockResolvedValue(undefined);
  vi.clearAllMocks();
});
afterEach(() => { probe?.unmount(); probe = null; });
const settled = () => act(async () => { await Promise.resolve(); });

describe("useToastSync", () => {
  it("skips fresh unchanged items and updates or dismisses only changed ids", async () => {
    probe = mountProbe(<Owner items={[{ id: "a", title: "A" }, { id: "b", title: "B" }]} />);
    await settled();
    expect(toast.warning).toHaveBeenCalledTimes(2);
    vi.clearAllMocks();
    probe.rerender(<Owner items={[{ id: "a", title: "A" }, { id: "b", title: "B" }]} />);
    await settled();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(loader).not.toHaveBeenCalled();
    probe.rerender(<Owner items={[{ id: "a", title: "Changed" }]} />);
    await settled();
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith("Changed", { id: "a" });
    expect(toast.dismiss).toHaveBeenCalledExactlyOnceWith("b");
  });

  it("shows nothing if the library loads after unmount", async () => {
    let ready!: () => void;
    loader.mockReturnValue(new Promise<void>((resolve) => { ready = resolve; }));
    probe = mountProbe(<Owner items={[{ id: "a", title: "A" }]} />);
    probe.unmount();
    probe = null;
    await act(async () => { ready(); });
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.dismiss).not.toHaveBeenCalled();
  });

  it("discards stale lists while the library loads", async () => {
    let ready!: () => void;
    loader.mockReturnValue(new Promise<void>((resolve) => { ready = resolve; }));
    probe = mountProbe(<Owner items={[{ id: "old", title: "Old" }]} />);
    probe.rerender(<Owner items={[{ id: "new", title: "New" }]} />);
    await act(async () => { ready(); });
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith("New", { id: "new" });
  });

  it("dismisses secondary toasts on removal and unmount", async () => {
    probe = mountProbe(<Owner secondary items={[{ id: "a", title: "A" }, { id: "b", title: "B" }]} />);
    await settled();
    probe.rerender(<Owner secondary items={[{ id: "b", title: "B" }]} />);
    await settled();
    expect(toast.dismiss.mock.calls).toEqual([["a:more"], ["a"]]);
    toast.dismiss.mockClear();
    probe.unmount();
    probe = null;
    expect(toast.dismiss.mock.calls).toEqual([["b:more"], ["b"]]);
  });

  it("keeps one toast through StrictMode effect replay and dismisses it on exit", async () => {
    probe = mountProbe(<StrictMode><Owner items={[{ id: "a", title: "A" }]} /></StrictMode>);
    await settled();
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith("A", { id: "a" });
    probe.unmount();
    probe = null;
    expect(toast.dismiss).toHaveBeenCalledExactlyOnceWith("a");
  });
});
