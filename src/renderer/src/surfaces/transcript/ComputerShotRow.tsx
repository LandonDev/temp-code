import { useEffect, useRef, useState } from "react";
import { Skeleton } from "../../components/ui/skeleton";
import { openLightbox, type LightboxItem } from "../../chrome/lightboxStore";
import { cn } from "../../lib/cn";
import { registry } from "../../lib/connection";
import { fileMedia } from "../../lib/fs";
import { assetHref } from "../../lib/nativeWeb";
import { missingFileText } from "../../lib/pathHost";
import type { Block } from "../../lib/session";
import type { ApprovalDecision } from "../../lib/harness";
import type { OpenFileFn } from "../../lib/search";
import { computerShotsOf, type ComputerShot } from "../computerShots";
import { ToolCall } from "./ToolCall";

/**
 * A computer call that returned a picture the model asked for (docs/DESIGN.md
 * "The transcript"): its action line as a lone step draws it, then 8px under
 * it the picture, read through `fs.media` from the thread's own host. One
 * picture takes the column's width and its own shape, at most 320px tall;
 * two to four sit in one line 8px apart, each at most 240px tall. The shape
 * is set from the shot line before a byte arrives, so the row's height is
 * right from its first frame. A click opens the lightbox on the call's
 * pictures, from the one clicked.
 */

const ONE_MAX = 320;
const SEVERAL_MAX = 240;
/** What one line holds; the result attaches at most this many (MAX_IMAGE_PARTS). */
const LINE_MAX = 4;

export type ShotMedia = { status: "pending" } | { status: "ready"; url: string } | { status: "missing" };

function useShotMedia(host: string, path: string, known?: ShotMedia): ShotMedia {
  const [media, setMedia] = useState<ShotMedia>(known ?? { status: "pending" });
  useEffect(() => {
    if (known) return;
    let alive = true;
    setMedia({ status: "pending" });
    fileMedia(host, path).then(
      (m) => alive && setMedia(m && m.kind === "image" ? { status: "ready", url: assetHref(m.url) } : { status: "missing" }),
      () => alive && setMedia({ status: "missing" }),
    );
    return () => {
      alive = false;
    };
  }, [host, path, known]);
  return known ?? media;
}

const hostNameOf = (host: string): string | null => (host === registry.primaryEnvironmentId ? null : (registry.environment(host)?.name ?? "that host"));

function Picture({
  shot,
  host,
  max,
  share,
  known,
  onOpen,
}: {
  shot: ComputerShot;
  host: string;
  max: number;
  /** one of several in a line: an equal share of it */
  share: boolean;
  known?: ShotMedia;
  onOpen: (from: DOMRect, url: string | null) => void;
}) {
  const media = useShotMedia(host, shot.path, known);
  const box = useRef<HTMLButtonElement>(null);
  const aspect = shot.width / shot.height;
  if (media.status === "missing") {
    return (
      <p data-slot="computer-shot-missing" className="min-w-0 text-xs text-muted-foreground">
        {missingFileText(hostNameOf(host))}
      </p>
    );
  }
  return (
    <button
      ref={box}
      type="button"
      aria-label={shot.label}
      data-slot="computer-shot"
      onClick={() => box.current && onOpen(box.current.getBoundingClientRect(), media.status === "ready" ? media.url : null)}
      className={cn("relative block min-w-0 cursor-zoom-in overflow-hidden rounded-lg", share ? "flex-1" : "w-full")}
      style={{ aspectRatio: `${shot.width} / ${shot.height}`, maxWidth: `${Math.round(max * aspect)}px` }}
    >
      {media.status === "ready" ? (
        <img
          src={media.url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className="block size-full rounded-lg object-contain outline outline-1 -outline-offset-1 outline-image-outline"
        />
      ) : (
        <Skeleton className="absolute inset-0 rounded-lg" />
      )}
    </button>
  );
}

export function ComputerShotRow({
  block,
  host,
  cwd,
  onApproval,
  onOpenFile,
  onOpenDiff,
  media,
}: {
  block: Block;
  host: string;
  /** What each picture's host already said, by path (a fixture's still pictures); else fs.media asks. */
  media?: Readonly<Record<string, ShotMedia>>;
  cwd?: string;
  onApproval?: (requestId: string | number, decision: ApprovalDecision) => void;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
}) {
  const shots = computerShotsOf(block).slice(0, LINE_MAX);
  const urls = useRef(new Map<string, string>());
  const several = shots.length > 1;
  const open = (index: number, from: DOMRect, url: string | null): void => {
    if (url) urls.current.set(shots[index].path, url);
    const items: LightboxItem[] = shots.map((s) => {
      const src = urls.current.get(s.path);
      return src ? { environmentId: host, name: s.label, src } : { environmentId: host, name: s.label, path: s.path };
    });
    openLightbox(items, index, from);
  };
  return (
    <div data-slot="computer-shot-row" className="min-w-0">
      <ToolCall block={block} cwd={cwd} onApproval={onApproval} onOpenFile={onOpenFile} onOpenDiff={onOpenDiff} />
      <div className="mt-2 flex min-w-0 items-start gap-2">
        {shots.map((shot, i) => (
          <Picture
            key={shot.path}
            shot={shot}
            host={host}
            max={several ? SEVERAL_MAX : ONE_MAX}
            share={several}
            known={media?.[shot.path]}
            onOpen={(from, url) => open(i, from, url)}
          />
        ))}
      </div>
    </div>
  );
}
