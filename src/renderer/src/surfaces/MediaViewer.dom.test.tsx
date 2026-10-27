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
  basename: (path: string) => path.slice(path.lastIndexOf("/") + 1),
  fileMedia: (environmentId: string, path: string) => fileMedia(environmentId, path),
  gitFileMedia: (...args: unknown[]) => (gitFileMedia as (...a: unknown[]) => unknown)(...args),
}));
let watcher: (() => void) | null = null;
vi.mock("../lib/fileWatch", () => ({
  watchFile: (_path: string, onChange: () => void) => {
    watcher = onChange;
    return () => {};
  },
}));
vi.mock("../lib/connection", () => ({
  registry: {
    primaryEnvironmentId: "local",
    environment: (id: string) => (id === "env_box" ? { name: "box" } : undefined),
  },
}));

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

  it("shows an image from the asset URL with the folder and its facts in the header, never inline bytes", async () => {
    fileMedia.mockImplementation(() => Promise.resolve(image));
    const { container } = mount("/repo/img/shot.png");
    await act(async () => {});
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(image.url);
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("alt")).toBe("shot.png");
    expect(img.className).toContain("outline-image-outline");
    expect(img.className).not.toContain("rounded");
    expect(container.querySelector("video, footer")).toBeNull();
    expect(container.querySelector('[data-testid="editor"]')).toBeNull();
    expect(container.querySelector('[class*="bg-content"]')).toBeNull();
    const header = container.querySelector("header")!;
    expect(header.textContent).toContain("img");
    expect(header.textContent).not.toContain("shot.png");
    expect(header.textContent).toContain("2.0 KB");
    // Dimensions arrive from the decoded element, not the wire.
    Object.defineProperty(img, "naturalWidth", { value: 640 });
    Object.defineProperty(img, "naturalHeight", { value: 480 });
    await act(async () => {
      fireEvent.load(img);
    });
    const facts = [...header.querySelectorAll("span")].map((span) => span.textContent);
    expect(facts).toContain("640 × 480");
    expect(facts).toContain("2.0 KB");
    expect(container.textContent).not.toContain("·");
    expect(container.querySelector("[title]")).toBeNull();
  });

  it("switches between Fit and 100% from the header and from the image", async () => {
    fileMedia.mockImplementation(() => Promise.resolve(image));
    const { container } = mount("/repo/img/shot.png");
    await act(async () => {});
    const group = container.querySelector('[aria-label="Image size"]')!;
    const [fitItem, actualItem] = [...group.querySelectorAll("button")];
    expect(fitItem.textContent).toBe("Fit");
    expect(fitItem.getAttribute("aria-pressed")).toBe("true");
    const img = container.querySelector("img")!;
    const scroller = img.parentElement!.parentElement!;
    expect(scroller.hasAttribute("tabindex")).toBe(false);
    await act(async () => {
      fireEvent.click(actualItem);
    });
    expect(actualItem.getAttribute("aria-pressed")).toBe("true");
    expect(img.className).toContain("max-w-none");
    // At actual size the scroller is a tab stop the arrow keys scroll.
    expect(scroller.getAttribute("tabindex")).toBe("0");
    expect(scroller.getAttribute("aria-label")).toBe("shot.png at actual size");
    await act(async () => {
      fireEvent.click(img);
    });
    expect(img.className).not.toContain("max-w-none");
    expect(fitItem.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows a delayed loading line until the image decodes, and again for a rewritten file", async () => {
    fileMedia.mockImplementation(() => Promise.resolve(image));
    const { container } = mount("/repo/img/shot.png");
    await act(async () => {});
    let img = container.querySelector("img")!;
    expect(img.className).toContain("invisible");
    const line = container.querySelector('[role="status"]')!;
    expect(line.textContent).toBe("Loading…");
    expect(line.className).toContain("[--tw-animation-delay:var(--dur-slow)]");
    await act(async () => {
      fireEvent.load(img);
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(img.className).not.toContain("invisible");
    // The watcher hands back a fresh URL for a rewritten file.
    fileMedia.mockImplementation(() => Promise.resolve({ ...image, url: `${image.url}2` }));
    watcher!();
    await act(async () => {});
    img = container.querySelector("img")!;
    expect(img.className).toContain("invisible");
    expect(container.querySelector('[role="status"]')!.textContent).toBe("Loading…");
  });

  it("plays a video in a focused native player with controls and the hairline", async () => {
    fileMedia.mockImplementation(() => Promise.resolve(video));
    const { container } = mount("/repo/clip.mp4");
    await act(async () => {});
    const el = container.querySelector("video")!;
    expect(el.getAttribute("src")).toBe(video.url);
    expect(el.hasAttribute("controls")).toBe(true);
    expect(el.getAttribute("preload")).toBe("metadata");
    expect(el.hasAttribute("autoplay")).toBe(false);
    expect(document.activeElement).toBe(el);
    expect(el.className).not.toContain("rounded-sm");
    expect(el.className).toContain("outline-image-outline");
    expect(el.className).toContain("focus-visible:ring-2");
    expect(container.querySelector('[aria-label="Image size"]')).toBeNull();
    expect(container.querySelector("header")!.textContent).toContain("5.0 MB");
  });

  it("plays audio with controls and its size alone", async () => {
    fileMedia.mockImplementation(() => Promise.resolve(audio));
    const { container } = mount("/repo/song.mp3");
    await act(async () => {});
    const el = container.querySelector("audio")!;
    expect(el.hasAttribute("controls")).toBe(true);
    expect(el.className).toContain("focus-visible:ring-2");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("header")!.textContent).toBe("2.0 KB");
  });

  it("falls through to the editor (and its stub) for anything that is not media", async () => {
    const { container } = mount("/repo/a.ts");
    await act(async () => {});
    expect(fileMedia).toHaveBeenCalledWith("local", "/repo/a.ts");
    expect(container.querySelector('[data-testid="editor"]')).not.toBeNull();
    expect(container.querySelector("img, video, audio")).toBeNull();
  });

  it("in review captions the git side Before and the working file After, each with its own facts", async () => {
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
    const before = container.querySelector('section[aria-label="Before"]')!;
    const after = container.querySelector('section[aria-label="After"]')!;
    expect(before.contains(imgs[0])).toBe(true);
    expect(after.contains(imgs[1])).toBe(true);
    expect(before.textContent).toContain("1.0 KB");
    expect(after.textContent).toContain("2.0 KB");
    const header = container.querySelector("header")!;
    expect(header.textContent).not.toContain("KB");
    expect(header.textContent).not.toContain("→");
    expect(header.querySelector('[aria-label="Image size"]')).not.toBeNull();
  });

  it("in review shows the single image with its facts in the header when the file is untracked", async () => {
    fileMedia.mockImplementation(() => Promise.resolve(image));
    const { container } = mount("/repo/img/shot.png", true);
    await act(async () => {});
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.textContent).not.toContain("Before");
    expect(container.querySelector("header")!.textContent).toContain("2.0 KB");
  });
});

describe("a media element that fails", () => {
  const head = (answer: () => Promise<{ status: number }>) => {
    const fetch = vi.fn(answer);
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };
  afterEach(() => vi.unstubAllGlobals());

  const failOn = async (path: string, media: FileMedia, environmentId?: string, selector = "img") => {
    fileMedia.mockImplementation(() => Promise.resolve(media));
    const view = mount(path, false, environmentId);
    await act(async () => {});
    await act(async () => {
      fireEvent.error(view.container.querySelector(selector)!);
    });
    return view;
  };

  it("says a missing file is missing from its host, and Retry asks the host again", async () => {
    const fetch = head(() => Promise.resolve({ status: 404 }));
    const { container } = await failOn("/tmp/shot.png", image, "env_box");
    expect(fetch).toHaveBeenCalledWith(image.url, { method: "HEAD" });
    expect(container.textContent).toContain("Couldn’t open shot.png");
    expect(container.textContent).toContain("No such file on box.");
    expect(container.querySelector("header")).not.toBeNull();
    const calls = fileMedia.mock.calls.length;
    await act(async () => {
      fireEvent.click([...container.querySelectorAll("button")].find((b) => b.textContent === "Retry")!);
    });
    expect(fileMedia.mock.calls.length).toBe(calls + 1);
  });

  it("says the host is out of reach on a 503 or no answer", async () => {
    head(() => Promise.resolve({ status: 503 }));
    const { container, unmount } = await failOn("/tmp/shot.png", image, "env_box");
    expect(container.textContent).toContain("box is out of reach.");
    unmount();
    head(() => Promise.reject(new Error("link down")));
    const again = await failOn("/tmp/shot.png", image, "env_box");
    expect(again.container.textContent).toContain("box is out of reach.");
  });

  it("says an image it has the bytes for is not supported, with no Retry", async () => {
    head(() => Promise.resolve({ status: 200 }));
    const { container } = await failOn("/repo/photo.heic", { ...image, mime: "image/heic" });
    expect(container.textContent).toContain("Can’t show photo.heic");
    expect(container.textContent).toContain("This HEIC image isn’t supported here.");
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Retry")).toBe(false);
  });

  it("says a video it cannot decode cannot play", async () => {
    head(() => Promise.resolve({ status: 200 }));
    const { container } = await failOn("/repo/clip.mp4", video, undefined, "video");
    expect(container.textContent).toContain("Can’t play clip.mp4");
    expect(container.textContent).toContain("Its codec isn’t supported here.");
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
