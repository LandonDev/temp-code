import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Web mode: the bundle at /ui has no preload. Without `window.api` the
 * bridge answers from nativeWeb.ts: the slot is `web` (its own snapshot),
 * the terminal says it needs the desktop app, dialogs use the browser's.
 * And the seam stays single: no renderer file outside native.ts and
 * nativeWeb.ts may touch `window.api`.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("web mode", () => {
  it("is on when window.api is absent and off when preload set it", async () => {
    vi.stubGlobal("window", { location: { origin: "https://tc.example" } });
    const web = await import("./nativeWeb");
    expect(web.isWebMode()).toBe(true);
    vi.stubGlobal("window", { api: {} });
    expect(web.isWebMode()).toBe(false);
    expect(web.assetHref("tempcode-asset://logo/a.png")).toBe("tempcode-asset://logo/a.png");
  });
  it("routes native.ts through webApi: slot web, terminal refused, confirm for ask", async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("window", { confirm, location: { origin: "https://tc.example" } });
    vi.stubGlobal("location", { origin: "https://tc.example" });
    const native = await import("./native");
    expect(native.windowSlot()).toBe("web");
    await expect(native.invoke("pty_spawn", { id: "t", cwd: "/", cols: 80, rows: 24 })).rejects.toThrow(/Terminal needs the desktop app/);
    await expect(native.ask("sure?")).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith("sure?");
    await expect(native.getServerPort()).rejects.toThrow(/unavailable/);
    const { webSocketUrl, assetHref } = await import("./nativeWeb");
    expect(webSocketUrl()).toBe("wss://tc.example/ws");
    expect(assetHref("tempcode-asset://logo/a%20b.png")).toBe("/asset/logo/a%20b.png");
    expect(assetHref("tempcode-asset://file/tok/clip.mp4?v=1")).toBe("/asset/file/tok/clip.mp4?v=1");
    expect(assetHref("https://example.com/x.png")).toBe("https://example.com/x.png");
    expect(native.convertFileSrc("/Users/x/project-logos/acme.png")).toBe("/asset/logo/acme.png");
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
