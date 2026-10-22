import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { assetHref } from "../lib/nativeWeb";
import { fileMedia, gitFileMedia, type FileMedia } from "../lib/fs";
import { watchFile } from "../lib/fileWatch";
import { hostOfCwd } from "../lib/tcserver/projects";
import { displayPath } from "../lib/paths";

/**
 * Images, video and audio in the file pane. `MediaGate` asks main whether a
 * path is media before the text editor ever opens it: a media file renders
 * here, anything else falls through to the editor the pane chose. The bytes
 * come over `tempcode-asset://file/<token>/…` (streamed, Range-aware), never
 * through the WebSocket, so a large video scrubs and a large image decodes
 * only once it is on screen. `environmentId` is the host the file lives on
 * (a tab opened from a box thread's transcript names the box); without it
 * the catalog decides from the path. The URL the host mints names that
 * host, and the asset handler fetches a foreign host's bytes over the peer
 * link (src/main/assets.ts).
 */

type MediaState =
  | { status: "pending" }
  | { status: "none" }
  | { status: "media"; media: FileMedia };

export function useFileMedia(path: string, environmentId?: string): MediaState {
  const [state, setState] = useState<MediaState>({ status: "pending" });
  useEffect(() => {
    let cancelled = false;
    setState({ status: "pending" });
    const host = environmentId ?? hostOfCwd(path);
    const load = () =>
      fileMedia(host, path)
        .then((media) => {
          if (cancelled) return;
          setState(media ? { status: "media", media } : { status: "none" });
        })
        .catch(() => {
          if (!cancelled) setState({ status: "none" });
        });
    void load();
    // A rewritten image (an agent regenerating a screenshot) gets a fresh
    // URL: the mtime rides in the query, so the element fetches again.
    const unwatch = watchFile(path, () => void load(), host);
    return () => {
      cancelled = true;
      unwatch();
    };
  }, [path, environmentId]);
  return state;
}

export function MediaGate({
  path,
  cwd,
  environmentId,
  active,
  original,
  children,
}: {
  path: string;
  cwd: string;
  /** The host the file is read from; absent, the catalog decides from the path. */
  environmentId?: string;
  active: boolean;
  /** The git side of a review tab, resolved by the caller once this is media. */
  original?: (media: FileMedia) => ReactNode;
  children: () => ReactNode;
}) {
  const state = useFileMedia(path, environmentId);
  if (state.status === "pending") return null;
  if (state.status === "none") return <>{children()}</>;
  if (original) return <>{original(state.media)}</>;
  return (
    <MediaViewer path={path} cwd={cwd} media={state.media} active={active} />
  );
}

/**
 * A review tab on a media file: the git side (the index, or `base`) beside
 * the working file. Until git answers, the working file alone; when git has
 * no original (an untracked file) it stays that way.
 */
export function MediaReview({
  path,
  cwd,
  environmentId,
  media,
  active,
  base,
}: {
  path: string;
  cwd: string;
  environmentId?: string;
  media: FileMedia;
  active: boolean;
  base?: string;
}) {
  const [original, setOriginal] = useState<FileMedia | null>(null);
  useEffect(() => {
    let cancelled = false;
    const relative = displayPath(path, cwd);
    if (!relative || relative === path) return;
    gitFileMedia(environmentId ?? hostOfCwd(path), cwd, relative, base)
      .then((sides) => {
        if (!cancelled) setOriginal(sides.original);
      })
      .catch(() => {
        if (!cancelled) setOriginal(null);
      });
    return () => {
      cancelled = true;
    };
  }, [path, cwd, environmentId, base, media.url]);
  return (
    <MediaViewer
      path={path}
      cwd={cwd}
      media={media}
      active={active}
      original={original}
    />
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

type Dims = { width: number; height: number } | null;

function facts(d: Dims, m: FileMedia): string {
  return [d ? `${d.width} × ${d.height}` : null, formatBytes(m.size)]
    .filter(Boolean)
    .join(" · ");
}

export function MediaViewer({
  path,
  cwd,
  media,
  active,
  original,
}: {
  path: string;
  cwd: string;
  media: FileMedia;
  active: boolean;
  /** When set, the review view: `original` on the left, the working file on the right. */
  original?: FileMedia | null;
}) {
  const relativePath = displayPath(path, cwd);
  const [dims, setDims] = useState<Dims>(null);
  const [oldDims, setOldDims] = useState<Dims>(null);
  const [fit, setFit] = useState(true);
  const toggleFit = useCallback(() => setFit((f) => !f), []);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {original ? (
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 border-r border-content/10">
            <MediaBody
              media={original}
              fit={fit}
              active={false}
              onToggleFit={toggleFit}
              onDims={setOldDims}
            />
          </div>
          <div className="min-w-0 flex-1">
            <MediaBody
              media={media}
              fit={fit}
              active={active}
              onToggleFit={toggleFit}
              onDims={setDims}
            />
          </div>
        </div>
      ) : (
        <MediaBody
          media={media}
          fit={fit}
          active={active}
          onToggleFit={toggleFit}
          onDims={setDims}
        />
      )}
      <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-content/10 px-2.5 font-mono text-[11px] text-content/40">
        <span className="min-w-0 flex-1 truncate" title={path}>
          {relativePath}
        </span>
        <span className="shrink-0 tabular-nums">
          {original
            ? `${facts(oldDims, original)} → ${facts(dims, media)}`
            : facts(dims, media)}
        </span>
        {media.kind === "image" ? (
          <button
            type="button"
            onClick={toggleFit}
            className="shrink-0 rounded px-1 hover:bg-content/10 hover:text-content"
            title={fit ? "Show at actual size" : "Fit to pane"}
          >
            {fit ? "Fit" : "1:1"}
          </button>
        ) : null}
      </footer>
    </div>
  );
}

function MediaBody({
  media,
  fit,
  active,
  onToggleFit,
  onDims,
}: {
  media: FileMedia;
  fit: boolean;
  active: boolean;
  onToggleFit: () => void;
  onDims: (d: Dims) => void;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [media.url]);
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);

  // Space and the arrow keys drive the native controls when the element has
  // focus; give it focus with the tab so playback is one keypress away.
  useEffect(() => {
    if (active && media.kind !== "image")
      ref.current?.focus({ preventScroll: true });
  }, [active, media.kind]);

  if (failed) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-[12px] leading-5 text-content/50">
        {media.kind === "image"
          ? `Can’t decode this ${media.mime.replace(/^image\//, "").toUpperCase()} image.`
          : "Can’t play this file. Its codec isn’t supported here."}
      </div>
    );
  }

  if (media.kind === "image") {
    const onLoad = (e: SyntheticEvent<HTMLImageElement>) =>
      onDims({
        width: e.currentTarget.naturalWidth,
        height: e.currentTarget.naturalHeight,
      });
    return (
      <div
        className={`h-full min-h-0 overflow-auto bg-content/[0.03] ${fit ? "" : "cursor-zoom-out"}`}
        onDoubleClick={onToggleFit}
      >
        <div
          className={
            fit
              ? "grid h-full place-items-center p-4"
              : "grid min-h-full w-max min-w-full place-items-center p-4"
          }
        >
          <img
            src={assetHref(media.url)}
            alt=""
            draggable={false}
            loading="lazy"
            decoding="async"
            onLoad={onLoad}
            onError={() => setFailed(true)}
            onClick={fit ? onToggleFit : undefined}
            className={
              fit
                ? "max-h-full max-w-full cursor-zoom-in object-contain"
                : "max-w-none"
            }
          />
        </div>
      </div>
    );
  }

  if (media.kind === "video") {
    return (
      <div className="grid h-full min-h-0 place-items-center bg-content/[0.03] p-4">
        <video
          ref={ref}
          src={assetHref(media.url)}
          controls
          preload="metadata"
          tabIndex={0}
          onLoadedMetadata={(e) =>
            onDims({
              width: e.currentTarget.videoWidth,
              height: e.currentTarget.videoHeight,
            })
          }
          onError={() => setFailed(true)}
          className="max-h-full max-w-full rounded-sm outline-none"
        />
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 place-items-center p-4">
      <audio
        ref={ref}
        src={assetHref(media.url)}
        controls
        preload="metadata"
        tabIndex={0}
        onError={() => setFailed(true)}
        className="w-full max-w-md outline-none"
      />
    </div>
  );
}
