import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { assetHref } from "../lib/nativeWeb";
import { basename, fileMedia, gitFileMedia, type FileMedia } from "../lib/fs";
import { watchFile } from "../lib/fileWatch";
import { hostOfCwd } from "../lib/tcserver/projects";
import { displayPath } from "../lib/paths";
import { missingFileText } from "../lib/pathHost";
import { registry } from "../lib/connection";
import { cn } from "../lib/cn";
import { RotateCcw } from "../chrome/icons";
import { Button } from "../components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Spinner } from "../components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { FileHeader, fileFolder } from "./FileHeader";

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

/** The file's media facts, and `reload` to ask again (a fresh token, so a URL the host forgot works again). */
export function useFileMedia(path: string, environmentId?: string): { state: MediaState; reload: () => void } {
  const [state, setState] = useState<MediaState>({ status: "pending" });
  const [attempt, setAttempt] = useState(0);
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
  }, [path, environmentId, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, reload };
}

/** What a failed element needs to say why: the host's name (null here) and Retry. */
type MediaHost = { hostName: string | null; onReload?: () => void };
const MediaHostContext = createContext<MediaHost>({ hostName: null });

function hostNameOf(host: string): string | null {
  return host === registry.primaryEnvironmentId ? null : (registry.environment(host)?.name ?? "that host");
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
  const { state, reload } = useFileMedia(path, environmentId);
  if (state.status === "pending") return null;
  if (state.status === "none") return <>{children()}</>;
  const host: MediaHost = { hostName: hostNameOf(environmentId ?? hostOfCwd(path)), onReload: reload };
  if (original) return <MediaHostContext.Provider value={host}>{original(state.media)}</MediaHostContext.Provider>;
  return <MediaViewer path={path} cwd={cwd} media={state.media} active={active} {...host} />;
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
  const host = useContext(MediaHostContext);
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
  return <MediaViewer path={path} cwd={cwd} media={media} active={active} original={original} {...host} />;
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

/** The facts the header and the review captions show, each its own span. */
export function mediaFacts(d: Dims, m: FileMedia): string[] {
  return d && m.kind !== "audio" ? [`${d.width} × ${d.height}`, formatBytes(m.size)] : [formatBytes(m.size)];
}

function Facts({ facts }: { facts: string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-2 tabular-nums text-muted-foreground">
      {facts.map((fact) => (
        <span key={fact}>{fact}</span>
      ))}
    </span>
  );
}

/** Why an element could not use its bytes, as the asset handler's HEAD tells it. */
export type MediaFailure = "missing" | "unreachable" | "unsupported";

/** The toggle keeps the pane's focus where it was: a click never takes it. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

export function MediaViewer({
  path,
  cwd,
  media,
  active,
  original,
  hostName = null,
  onReload,
  initial,
}: {
  path: string;
  cwd: string;
  media: FileMedia;
  active: boolean;
  /** When set, the review view: `original` on the left, the working file on the right. */
  original?: FileMedia | null;
  /** The host the file lives on, null for this machine: a failure names it. */
  hostName?: string | null;
  /** Ask the host again; absent, a failure offers no Retry. */
  onReload?: () => void;
  /** The state to open in; the fixtures render each one statically. */
  initial?: { fit?: boolean; failure?: MediaFailure };
}) {
  const name = basename(path);
  const [dims, setDims] = useState<Dims>(null);
  const [oldDims, setOldDims] = useState<Dims>(null);
  const [fit, setFit] = useState(initial?.fit ?? true);
  const toggleFit = useCallback(() => setFit((f) => !f), []);
  const body = { name, fit, hostName, onReload, onToggleFit: toggleFit, failure: initial?.failure };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <FileHeader folder={fileFolder(path, cwd)}>
        {original ? null : <Facts facts={mediaFacts(dims, media)} />}
        {media.kind === "image" ? (
          <ToggleGroup
            size="sm"
            spacing={0}
            aria-label="Image size"
            value={[fit ? "fit" : "actual"]}
            onValueChange={(value) => {
              const next = value[0];
              if (next) setFit(next === "fit");
            }}
          >
            <ToggleGroupItem value="fit" className="text-[12px]" onMouseDown={keepFocus}>
              Fit
            </ToggleGroupItem>
            <ToggleGroupItem value="actual" className="text-[12px]" onMouseDown={keepFocus}>
              100%
            </ToggleGroupItem>
          </ToggleGroup>
        ) : null}
      </FileHeader>
      {original ? (
        <div className="flex min-h-0 flex-1">
          <ReviewSide label="Before" facts={mediaFacts(oldDims, original)} className="border-r border-border">
            <MediaBody key={original.url} media={original} active={false} onDims={setOldDims} {...body} />
          </ReviewSide>
          <ReviewSide label="After" facts={mediaFacts(dims, media)}>
            <MediaBody key={media.url} media={media} active={active} onDims={setDims} {...body} />
          </ReviewSide>
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <MediaBody key={media.url} media={media} active={active} onDims={setDims} {...body} />
        </div>
      )}
    </div>
  );
}

function ReviewSide({
  label,
  facts,
  className,
  children,
}: {
  label: string;
  facts: string[];
  className?: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className={cn("flex min-w-0 flex-1 flex-col", className)}>
      <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-[12px]">
        <span className="font-medium text-muted-foreground">{label}</span>
        <Facts facts={facts} />
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

/** The hairline on the media's own edge pixels: no wash, no radius. */
const OUTLINE = "outline outline-1 -outline-offset-1 outline-image-outline";
const FOCUS_RING = "outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Ask the asset handler why the element failed: 404 missing, 503 or no answer out of reach, else unsupported. */
async function diagnose(url: string, remote: boolean): Promise<MediaFailure> {
  try {
    const answer = await fetch(assetHref(url), { method: "HEAD" });
    if (answer.status === 404) return "missing";
    if (answer.status === 503 && remote) return "unreachable";
    return "unsupported";
  } catch {
    return remote ? "unreachable" : "unsupported";
  }
}

function MediaBody({
  media,
  name,
  fit,
  active,
  hostName,
  onReload,
  onToggleFit,
  onDims,
  failure: initialFailure,
}: {
  media: FileMedia;
  name: string;
  fit: boolean;
  active: boolean;
  hostName: string | null;
  onReload?: () => void;
  onToggleFit: () => void;
  onDims: (d: Dims) => void;
  failure?: MediaFailure;
}) {
  // Keyed by the URL: a rewritten file mounts afresh, its loading line and failure reset.
  const [failure, setFailure] = useState<MediaFailure | null>(initialFailure ?? null);
  const [loaded, setLoaded] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const onError = () =>
    void diagnose(media.url, hostName !== null).then((why) => {
      if (mounted.current) setFailure(why);
    });

  // Space and the arrow keys drive the native controls when the element has
  // focus; give it focus with the tab so playback is one keypress away.
  useEffect(() => {
    if (active && media.kind !== "image") ref.current?.focus({ preventScroll: true });
  }, [active, media.kind]);

  if (failure) return <FailureState failure={failure} media={media} name={name} hostName={hostName} onReload={onReload} />;

  if (media.kind === "image") {
    const onLoad = (e: SyntheticEvent<HTMLImageElement>) => {
      setLoaded(true);
      onDims({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight });
    };
    return (
      <div
        className={cn("relative h-full min-h-0 overflow-auto", !fit && FOCUS_RING, !fit && "focus-visible:ring-inset")}
        tabIndex={fit ? undefined : 0}
        aria-label={fit ? undefined : `${name} at actual size`}
      >
        <div
          className={fit ? "grid h-full place-items-center p-4" : "grid min-h-full w-max min-w-full place-items-center p-4"}
        >
          <img
            src={assetHref(media.url)}
            alt={name}
            draggable={false}
            loading="lazy"
            decoding="async"
            onLoad={onLoad}
            onError={onError}
            // One switch per click: a double-click is one gesture, not two.
            onClick={(e) => {
              if (e.detail <= 1) onToggleFit();
            }}
            className={cn(
              OUTLINE,
              fit ? "max-h-full max-w-full cursor-zoom-in object-contain" : "max-w-none cursor-zoom-out",
              !loaded && "invisible",
            )}
          />
        </div>
        {loaded ? null : <LoadingLine />}
      </div>
    );
  }

  if (media.kind === "video") {
    return (
      <div className="grid h-full min-h-0 place-items-center p-4">
        <video
          ref={ref}
          src={assetHref(media.url)}
          aria-label={name}
          controls
          preload="metadata"
          tabIndex={0}
          onLoadedMetadata={(e) => onDims({ width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight })}
          onError={onError}
          className={cn("max-h-full max-w-full", OUTLINE, "focus-visible:ring-2 focus-visible:ring-ring")}
        />
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 place-items-center p-4">
      <audio
        ref={ref}
        src={assetHref(media.url)}
        aria-label={name}
        controls
        preload="metadata"
        tabIndex={0}
        onError={onError}
        className={cn("w-full max-w-md rounded-full", FOCUS_RING)}
      />
    </div>
  );
}

/** Fades in only after --dur-slow, so an image that decodes at once never shows it. */
function LoadingLine() {
  return (
    <div
      role="status"
      className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-[12px] text-muted-foreground animate-in fade-in fill-mode-both duration-(--dur-base) [--tw-animation-delay:var(--dur-slow)]"
    >
      <Spinner aria-hidden="true" role="presentation" />
      Loading…
    </div>
  );
}

function FailureState({
  failure,
  media,
  name,
  hostName,
  onReload,
}: {
  failure: MediaFailure;
  media: FileMedia;
  name: string;
  hostName: string | null;
  onReload?: () => void;
}) {
  const [title, line] =
    failure === "missing"
      ? [`Couldn’t open ${name}`, missingFileText(hostName)]
      : failure === "unreachable"
        ? [`Couldn’t open ${name}`, `${hostName ?? "The host"} is out of reach.`]
        : media.kind === "image"
          ? [`Can’t show ${name}`, `This ${media.mime.replace(/^image\//, "").toUpperCase()} image isn’t supported here.`]
          : [`Can’t play ${name}`, "Its codec isn’t supported here."];
  // A retry can bring a file or a host back, never a codec.
  const retry = failure !== "unsupported" && onReload;
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{line}</EmptyDescription>
      </EmptyHeader>
      {retry ? (
        <EmptyContent>
          <Button variant="secondary" size="sm" onClick={onReload}>
            <RotateCcw />
            Retry
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
