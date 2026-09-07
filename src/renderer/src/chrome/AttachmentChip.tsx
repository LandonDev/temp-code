import { useEffect, useState } from "react";
import { X } from "./icons";
import { attachmentPreviewSrc } from "../lib/attachments";
import type { Attachment } from "../lib/session";
import { readAttachment } from "../lib/tcserver/commands";
import { FileTypeIcon } from "./FileTypeIcon";

const loaded = new Map<string, Promise<string | null>>();

/** A history image carries only its path; the server hands back its bytes once. */
function useAttachmentSrc(attachment: Attachment): string | undefined {
  const direct = attachmentPreviewSrc(attachment);
  const path = !direct && attachment.kind === "image" ? attachment.path : undefined;
  const [fetched, setFetched] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    let pending = loaded.get(path);
    if (!pending) {
      pending = readAttachment(path).catch(() => null);
      loaded.set(path, pending);
    }
    void pending.then((src) => {
      if (live) setFetched(src);
    });
    return () => {
      live = false;
    };
  }, [path]);
  return direct ?? (path ? (fetched ?? undefined) : undefined);
}

type Props = {
  attachment: Attachment;
  onRemove?: () => void;
};

export function AttachmentChip({ attachment, onRemove }: Props) {
  const preview = useAttachmentSrc(attachment);
  const image = attachment.kind === "image" && preview;

  return (
    <div
      className={`group relative flex min-w-0 items-center gap-1.5 rounded-md ${
        image ? "" : "bg-content/10 py-0.5 pl-1 pr-1"
      }`}
      title={attachment.path ?? attachment.name}
      data-attachment-path={attachment.path}
    >
      {image ? (
        <img
          src={preview}
          alt=""
          className={`size-9 shrink-0 rounded-lg object-cover ${
            attachment.textPath ? "w-14" : ""
          }`}
        />
      ) : (
        <>
          <span className="grid size-5 shrink-0 place-items-center">
            <FileTypeIcon name={attachment.name} isDir={false} size={16} />
          </span>
          <span className="min-w-0 max-w-[140px] truncate text-[11px] leading-none text-content/80">
            {attachment.name}
          </span>
        </>
      )}
      {onRemove ? (
        <button
          type="button"
          title="Remove"
          aria-label={`Remove ${attachment.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className={`grid shrink-0 place-items-center rounded-full text-content/70 hover:bg-content/15 hover:text-content ${
            image
              ? "absolute -right-1 -top-1 size-5 bg-content/20 opacity-100 shadow-sm backdrop-blur-sm"
              : "size-4 text-content/40"
          }`}
        >
          <X className={image ? "size-3" : "size-3"} strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );
}
