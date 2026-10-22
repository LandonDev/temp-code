// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileMedia } from "../lib/fs";

const fileMedia = vi.fn<(environmentId: string, path: string) => Promise<FileMedia | null>>(() =>
  Promise.resolve(null),
);
const gitFileMedia = vi.fn(() =>
  Promise.resolve({ original: null as FileMedia | null, current: null }),
);
vi.mock("../lib/fs", () => ({
  fileMedia: (environmentId: string, path: string) => fileMedia(environmentId, path),
  gitFileMedia: (...args: unknown[]) => (gitFileMedia as (...a: unknown[]) => unknown)(...args),
}));
vi.mock("../lib/fileWatch", () => ({ watchFile: () => () => {} }));

import { MediaGate, MediaReview, formatBytes } from "./MediaViewer";

const image: FileMedia = {
  kind: "image",
  mime: "image/png",
  url: "tempcode-asset://file/0123456789abcdef0123456789abcdef/shot.png?v=1",
  size: 2048,
  mtimeMs: 1,
};
const video: FileMedia = {
  ...image,
  kind: "video",
  mime: "video/mp4",
  url: "tempcode-asset://file/0123456789abcdef0123456789abcdef/clip.mp4?v=1",
  size: 5 * 1024 * 1024,
};
const audio: FileMedia = {
  ...image,
  kind: "audio",
  mime: "audio/mpeg",
  url: "tempcode-asset://file/0123456789abcdef0123456789abcdef/song.mp3?v=1",
};

const mount = (path: string, review = false, environmentId?: string) =>
  render(
    <MediaGate
      path={path}
      cwd="/repo"
      environmentId={environmentId}
      active
      original={
        review
          ? (media) => (
              <MediaReview path={path} cwd="/repo" media={media} active />
            )
          : undefined
      }
    >
      {() => <div data-testid="editor">editor</div>}
    </MediaGate>,
  );

afterEach(() => {
  fileMedia.mockReset();
  fileMedia.mockImplementation(() => Promise.resolve(null));
  gitFileMedia.mockReset();
  gitFileMedia.mockImplementation(() =>
    Promise.resolve({ original: null, current: null }),
  );
});

describe("MediaGate", () => {
  it("asks the host the tab names, and the catalog's guess only without one", async () => {
    const remote = { ...image, url: `${image.url}&host=env_box` };
    fileMedia.mockImplementation(() => Promise.resolve(remote));
    const { container, unmount } = mount("/tmp/shot.png", false, "env_box");
    await act(async () => {});
    expect(fileMedia).toHaveBeenCalledWith("env_box", "/tmp/shot.png");
    // The URL the host minted, host and all: the asset handler reads from there.
    expect(container.querySelector("img")!.getAttribute("src")).toBe(remote.url);
    unmount();
    mount("/tmp/shot.png");
    await act(async () => {});
    expect(fileMedia).toHaveBeenLastCalledWith("local", "/tmp/shot.png");
  });

  it("shows an image from the asset URL with its facts in the footer, never inline bytes", async () => {
    fileMedia.mockImplementation(() => Promise.resolve(image));
    const { container } = mount("/repo/img/shot.png");
    await act(async () => {});
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(image.url);
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector('[data-testid="editor"]')).toBeNull();
    expect(container.textContent).toContain("img/shot.png");
    expect(container.textContent).toContain("2.0 KB");
    // Dimensions arrive from the decoded element, not the wire.
    Object.defineProperty(img, "naturalWidth", { value: 640 });
    Object.defineProperty(img, "naturalHeight", { value: 480 });
    await act(async () => {
      fireEvent.load(img);
    });
    expect(container.textContent).toContain("640 × 480");
    // Fit ↔ 1:1 from the footer button.
    const toggle = container.querySelector("footer button")!;
    expect(toggle.textContent).toBe("Fit");
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(toggle.textContent).toBe("1:1");
    expect(img.className).toContain("max-w-none");
  });

  it("plays a video in a focused native player with controls", async () => {
    fileMedia.mockImplementation(() => Promise.resolve(video));
    const { container } = mount("/repo/clip.mp4");
    await act(async () => {});
    const el = container.querySelector("video")!;
    expect(el.getAttribute("src")).toBe(video.url);
    expect(el.hasAttribute("controls")).toBe(true);
    expect(el.getAttribute("preload")).toBe("metadata");
    expect(el.hasAttribute("autoplay")).toBe(false);
    expect(document.activeElement).toBe(el);
    expect(container.querySelector("footer button")).toBeNull();
    expect(container.textContent).toContain("5.0 MB");
  });

  it("plays audio with controls", async () => {
    fileMedia.mockImplementation(() => Promise.resolve(audio));
    const { container } = mount("/repo/song.mp3");
    await act(async () => {});
    expect(container.querySelector("audio")!.hasAttribute("controls")).toBe(true);
    expect(container.querySelector("img")).toBeNull();
  });

  it("falls through to the editor (and its stub) for anything that is not media", async () => {
    const { container } = mount("/repo/a.ts");
    await act(async () => {});
    expect(fileMedia).toHaveBeenCalledWith("local", "/repo/a.ts");
    expect(container.querySelector('[data-testid="editor"]')).not.toBeNull();
    expect(container.querySelector("img, video, audio")).toBeNull();
  });

  it("says so when the element cannot decode the file", async () => {
    fileMedia.mockImplementation(() => Promise.resolve({ ...image, mime: "image/heic" }));
    const { container } = mount("/repo/photo.heic");
    await act(async () => {});
    await act(async () => {
      fireEvent.error(container.querySelector("img")!);
    });
    expect(container.textContent).toContain("Can’t decode this HEIC image.");
  });

  it("in review shows the git side beside the working file when git has one", async () => {
    fileMedia.mockImplementation(() => Promise.resolve(image));
    const old = { ...image, url: image.url.replace("shot.png", "old.png"), size: 1024 };
    gitFileMedia.mockImplementation(() => Promise.resolve({ original: old, current: image }));
    const { container } = mount("/repo/img/shot.png", true);
    await act(async () => {});
    expect(gitFileMedia).toHaveBeenCalledWith("local", "/repo", "img/shot.png", undefined);
    const imgs = container.querySelectorAll("img");
    expect(imgs).toHaveLength(2);
    expect(imgs[0].getAttribute("src")).toBe(old.url);
    expect(imgs[1].getAttribute("src")).toBe(image.url);
    expect(container.textContent).toContain("1.0 KB → 2.0 KB");
  });

  it("in review shows the single image when the file is untracked", async () => {
    fileMedia.mockImplementation(() => Promise.resolve(image));
    const { container } = mount("/repo/img/shot.png", true);
    await act(async () => {});
    expect(container.querySelectorAll("img")).toHaveLength(1);
  });
});

describe("formatBytes", () => {
  it("rounds the way a file manager does", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(12 * 1024)).toBe("12 KB");
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
  });
});

vi.mock("../lib/tcserver/projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tcserver/projects")>()),
  hostOfCwd: () => "local",
}));
