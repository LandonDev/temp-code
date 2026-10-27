const svg = (w: number, h: number, fill: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${fill}"/><circle cx="${w / 2}" cy="${h / 2}" r="${h / 4}" fill="white" fill-opacity="0.6"/></svg>`,
  )}`;
const image = { kind: "image", mime: "image/png", url: svg(320, 200, "#5b7fa3"), size: 2048, mtimeMs: 1 };
const before = { ...image, url: svg(320, 200, "#8a6f9e"), size: 1024 };
const video = { kind: "video", mime: "video/mp4", url: "data:video/mp4,", size: 5 * 1024 * 1024, mtimeMs: 1 };
const audio = { kind: "audio", mime: "audio/mpeg", url: "data:audio/mpeg,", size: 3 * 1024 * 1024, mtimeMs: 1 };
const base = { path: "/repo/docs/img/shot.png", cwd: "/repo", active: false };

export default [
  { name: "image, fit (the loading line until it decodes)", props: { ...base, media: image } },
  { name: "image at 100%", props: { ...base, media: image, initial: { fit: false } } },
  { name: "review, Before and After", props: { ...base, media: image, original: before } },
  { name: "video", props: { ...base, path: "/repo/clip.mp4", media: video } },
  { name: "audio", props: { ...base, path: "/repo/song.mp3", media: audio } },
  { name: "missing on the box", props: { ...base, media: image, hostName: "box", onReload: "fn", failure: "missing" } },
  { name: "box out of reach", props: { ...base, media: image, hostName: "box", onReload: "fn", failure: "unreachable" } },
  { name: "unsupported image", props: { ...base, path: "/repo/photo.heic", media: { ...image, mime: "image/heic" }, failure: "unsupported" } },
];
