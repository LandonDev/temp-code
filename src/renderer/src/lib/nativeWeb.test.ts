import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ui = vi.hoisted(() => ({
  asked: [] as { request: unknown; answer: (ok: boolean) => void }[],
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));
vi.mock("../chrome/ConfirmDialog", () => ({
  confirmAction: (request: unknown) => new Promise<boolean>((answer) => ui.asked.push({ request, answer })),
}));
vi.mock("sonner", () => ({ toast: ui.toast }));

/**
 * Web mode: the bundle at /ui has no preload. Without `window.api` the
 * bridge answers from nativeWeb.ts: the slot is `web` (its own snapshot),
 * the terminal says it needs the desktop app, an ask is the app's confirm
 * dialog and a message a toast, never the browser's confirm or alert.
 * And the seam stays single: no renderer file outside native.ts and
 * nativeWeb.ts may touch `window.api`.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("web mode", () => {
  it("desktopOnly drops a handler at /ui and keeps it on the desktop", async () => {
    const web = await import("./nativeWeb");
    const handler = () => {};
    vi.stubGlobal("window", { location: { origin: "https://tc.example" } });
    expect(web.desktopOnly(handler)).toBeUndefined();
    vi.stubGlobal("window", { api: {} });
    expect(web.desktopOnly(handler)).toBe(handler);
    expect(web.DESKTOP_ONLY_LINE).toBe("Available in the desktop app");
  });
  it("is on when window.api is absent and off when preload set it", async () => {
    vi.stubGlobal("window", { location: { origin: "https://tc.example" } });
    const web = await import("./nativeWeb");
    expect(web.isWebMode()).toBe(true);
    vi.stubGlobal("window", { api: {} });
    expect(web.isWebMode()).toBe(false);
    expect(web.assetHref("tempcode-asset://logo/a.png")).toBe("tempcode-asset://logo/a.png");
  });
  it("routes native.ts through webApi: slot web, terminal refused", async () => {
    vi.stubGlobal("window", { location: { origin: "https://tc.example" } });
    vi.stubGlobal("location", { origin: "https://tc.example" });
    const native = await import("./native");
    expect(native.windowSlot()).toBe("web");
    await expect(native.invoke("pty_spawn", { id: "t", cwd: "/", cols: 80, rows: 24 })).rejects.toThrow(/Terminal needs the desktop app/);
    await expect(native.getServerPort()).rejects.toThrow(/unavailable/);
    const { webSocketUrl, assetHref } = await import("./nativeWeb");
    expect(webSocketUrl()).toBe("wss://tc.example/ws");
    expect(assetHref("tempcode-asset://logo/a%20b.png")).toBe("/asset/logo/a%20b.png");
    expect(assetHref("tempcode-asset://file/tok/clip.mp4?v=1")).toBe("/asset/file/tok/clip.mp4?v=1");
    expect(assetHref("https://example.com/x.png")).toBe("https://example.com/x.png");
    expect(native.convertFileSrc("/Users/x/project-logos/acme.png")).toBe("/asset/logo/acme.png");
  });
});

describe("dialogs at /ui", () => {
  const page = () => {
    const confirm = vi.fn(() => true);
    const alert = vi.fn();
    vi.stubGlobal("window", { confirm, alert, location: { origin: "https://tc.example" } });
    vi.stubGlobal("location", { origin: "https://tc.example" });
    ui.asked = [];
    ui.toast.mockClear();
    ui.toast.error.mockClear();
    return { confirm, alert };
  };

  it("asks through the app's confirm dialog and answers its verb and its Cancel", async () => {
    const browser = page();
    const native = await import("./native");
    const quit = native.ask("2 threads are working.\n\nQuit anyway?", { title: "TempCode", kind: "warning", okLabel: "Quit" });
    expect(ui.asked[0].request).toEqual({ title: "TempCode", body: "2 threads are working.\n\nQuit anyway?", action: "Quit", danger: true });
    ui.asked[0].answer(true);
    await expect(quit).resolves.toBe(true);
    const plain = native.ask("Delete the draft?\n\nIt cannot be restored.");
    expect(ui.asked[1].request).toEqual({ title: "Delete the draft?", body: "It cannot be restored.", action: "OK" });
    ui.asked[1].answer(false);
    await expect(plain).resolves.toBe(false);
    expect(browser.confirm).not.toHaveBeenCalled();
  });

  it("says a message in a toast, an error as an error toast", async () => {
    const browser = page();
    const native = await import("./native");
    await native.message("You're on the latest release.", { title: "TempCode" });
    await native.message("Couldn't check for updates.\n\noffline", { kind: "error" });
    await vi.waitFor(() => expect(ui.toast.error).toHaveBeenCalled());
    expect(ui.toast).toHaveBeenCalledWith("You're on the latest release.", undefined);
    expect(ui.toast.error).toHaveBeenCalledWith("Couldn't check for updates.", { description: "offline" });
    expect(browser.alert).not.toHaveBeenCalled();
  });
});

describe("the Electron seam", () => {
  it("no renderer source outside native.ts and nativeWeb.ts touches window.api", () => {
    const root = join(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== "test" && name !== "node_modules") walk(path);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name) || /\.d\.ts$/.test(name)) continue;
        if (path.endsWith("/lib/native.ts") || path.endsWith("/lib/nativeWeb.ts")) continue;
        if (/\bwindow\.api\b/.test(readFileSync(path, "utf8"))) offenders.push(path.slice(root.length + 1));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
