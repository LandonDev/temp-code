// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatShotLine } from "@shared/computer/tools";
import type { Block } from "../../lib/session";

const { fileMedia, openLightbox } = vi.hoisted(() => ({ fileMedia: vi.fn(), openLightbox: vi.fn() }));
vi.mock("../../lib/fs", () => ({ fileMedia }));
vi.mock("../../chrome/lightboxStore", () => ({ openLightbox }));
vi.mock("./ToolCall", () => ({ ToolCall: ({ block }: { block: Block }) => <div data-slot="tool-line">{block.tool?.name}</div> }));

import { registry } from "../../lib/connection";
import { ComputerShotRow } from "./ComputerShotRow";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const shot = (n: number, width = 1280, height = 800) => ({ path: `/w/.temp-code/attachments/s1/computer/000${n}.jpg`, width, height });
const block = (shots: { path: string; width: number; height: number }[]): Block => ({
  id: "b1",
  role: "tool",
  text: "computer",
  tool: {
    callId: "c1",
    name: "mcp__app__computer_batch",
    status: "completed",
    input: { app: "TextEdit", actions: shots.map(() => ({ action: "screenshot" })) },
    detail: [...shots.map(() => "screenshot"), ...shots.map((s, i) => formatShotLine(i + 1, i + 1, s, true)), "", 'app "TextEdit" · window "Untitled" · 1280×800'].join("\n"),
  },
});
const media = (path: string) => ({ kind: "image", mime: "image/jpeg", size: 10, url: `tempcode-asset://file/${path.slice(-8)}?v=1` });
const flush = () => act(async () => {});

describe("ComputerShotRow", () => {
  it("draws the call's line, then its picture 8px under it, its shape set before a byte arrives", () => {
    fileMedia.mockReturnValue(new Promise(() => {}));
    render(<ComputerShotRow block={block([shot(1)])} host="local" />);
    expect(document.querySelector('[data-slot="tool-line"]')).toBeTruthy();
    const picture = screen.getByRole("button", { name: "Screenshot of TextEdit" });
    expect(picture.parentElement!.className).toContain("mt-2");
    expect(picture.style.aspectRatio).toBe("1280 / 800");
    expect(picture.style.maxWidth).toBe(`${Math.round(320 * 1.6)}px`);
    expect(picture.className).toContain("w-full");
    expect(picture.className).toContain("cursor-zoom-in");
    expect(picture.querySelector('[data-slot="skeleton"]')).toBeTruthy();
    expect(picture.querySelector("img")).toBeNull();
  });

  it("loads the picture from the thread's own host, lazily, with the image outline", async () => {
    fileMedia.mockImplementation(async (_host: string, path: string) => media(path));
    render(<ComputerShotRow block={block([shot(1)])} host="env_box" />);
    await flush();
    expect(fileMedia).toHaveBeenCalledWith("env_box", shot(1).path);
    const img = screen.getByRole("button").querySelector("img")!;
    expect(img.getAttribute("src")).toContain("tempcode-asset://file/");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("decoding")).toBe("async");
    expect(img.className).toContain("outline-image-outline");
    expect(img.className).toContain("rounded-lg");
  });

  it("sets several pictures in one line 8px apart, each at most 240px tall", async () => {
    fileMedia.mockImplementation(async (_host: string, path: string) => media(path));
    render(<ComputerShotRow block={block([shot(1), shot(2, 800, 1200), shot(3)])} host="local" />);
    await flush();
    const pictures = screen.getAllByRole("button");
    expect(pictures).toHaveLength(3);
    expect(pictures[0].parentElement!.className).toContain("gap-2");
    for (const p of pictures) expect(p.className).toContain("flex-1");
    expect(pictures[1].style.maxWidth).toBe(`${Math.round((240 * 800) / 1200)}px`);
  });

  it("opens the lightbox on the call's pictures, from the one clicked", async () => {
    fileMedia.mockImplementation(async (_host: string, path: string) => media(path));
    render(<ComputerShotRow block={block([shot(1), shot(2)])} host="local" />);
    await flush();
    fireEvent.click(screen.getAllByRole("button")[1]);
    expect(openLightbox).toHaveBeenCalledTimes(1);
    const [items, index, from] = openLightbox.mock.calls[0];
    expect(index).toBe(1);
    expect(from).toBeTruthy();
    expect(items).toHaveLength(2);
    expect(items[1]).toEqual({ environmentId: "local", name: "Screenshot of TextEdit", src: media(shot(2).path).url });
    expect(items[0]).toMatchObject({ environmentId: "local", name: "Screenshot of TextEdit" });
  });

  it("says a file the host no longer has in the picture's place, naming the host", async () => {
    vi.spyOn(registry, "environment").mockReturnValue({ name: "The box" } as never);
    fileMedia.mockResolvedValue(null);
    render(<ComputerShotRow block={block([shot(1)])} host="env_box" />);
    await flush();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("No such file on The box.")).toBeTruthy();
  });
});
