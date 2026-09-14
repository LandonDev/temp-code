import { X } from "./icons";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { LAYER } from "../lib/layers";

export type ModalSize = "sm" | "md";

const WIDTH: Record<ModalSize, string> = {
  sm: "w-[min(420px,calc(100vw-24px))]",
  md: "w-[min(560px,calc(100vw-24px))]",
};

const TOP: Record<ModalSize, string> = {
  sm: "top-[22%]",
  md: "top-[10%]",
};

type Props = {
  onClose: () => void;
  /** Work in flight: Escape, the backdrop, and the close button all wait. */
  busy?: boolean;
  title: string;
  description?: string;
  size?: ModalSize;
  /** Extra classes on the panel (fixed height, etc). */
  className?: string;
  children: ReactNode;
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Plays a fading copy of `el` in its place so an unmounted layer can still leave. */
export function ghostOut(el: HTMLElement, closingClass: string, ms: number) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const ghost = el.cloneNode(true) as HTMLElement;
  ghost.classList.add(closingClass);
  ghost.style.pointerEvents = "none";
  ghost.setAttribute("aria-hidden", "true");
  ghost.setAttribute("inert", "");
  document.body.appendChild(ghost);
  window.setTimeout(() => ghost.remove(), ms);
}

export function ModalPanel({
  onClose,
  busy = false,
  title,
  description,
  size = "md",
  className,
  children,
}: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const uid = useId();
  const titleId = `${uid}-title`;
  const descriptionId = description ? `${uid}-desc` : undefined;

  const panelRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // Focus lands on the close button and, on unmount, returns to wherever it
  // came from.
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) onClose();
        return;
      }
      if (event.key !== "Tab") return;
      // Tab cycles inside the panel; focus never leaves the dialog.
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);
      if (!inside) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className={`absolute left-1/2 ${TOP[size]} ${WIDTH[size]} -translate-x-1/2`}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-busy={busy || undefined}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onMouseDown={(event) => event.stopPropagation()}
        className={`modal-panel flex flex-col overflow-hidden rounded-2xl border border-content/10 bg-background-base/55 shadow-2xl glass-surface glass-surface--xl ${className ?? ""}`}
      >
        <header className="flex shrink-0 items-start gap-2 px-4 pt-3">
          <div className="min-w-0 flex-1 pt-0.5">
            <h2
              id={titleId}
              className="text-2xl font-semibold leading-tight text-content"
            >
              {title}
            </h2>
            {description ? (
              <p
                id={descriptionId}
                className="mt-0.5 truncate text-[12px] leading-snug text-content/50"
              >
                {description}
              </p>
            ) : null}
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
            className="grid size-7 shrink-0 place-items-center rounded-md text-content/40 hover:bg-content/8 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </header>
        <div
          ref={lockOverscroll}
          className="min-h-0 flex-1 overflow-y-auto overscroll-none"
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export const MODAL_OUT_MS = 120;

export function Modal(props: Props) {
  const layerRef = useRef<HTMLDivElement>(null);
  const { busy, onClose } = props;

  // The parent unmounts us outright; a ghost copy plays the exit. A layer
  // still connected at cleanup is StrictMode rehearsing, not a real close.
  useEffect(() => {
    const layer = layerRef.current;
    return () => {
      if (layer && !layer.isConnected) {
        ghostOut(layer, "modal-closing", MODAL_OUT_MS);
      }
    };
  }, []);

  return createPortal(
    <div ref={layerRef} className="fixed inset-0" style={{ zIndex: LAYER.dialog }}>
      <div
        className="modal-backdrop absolute inset-0 bg-black/40"
        onMouseDown={busy ? undefined : onClose}
      />
      <ModalPanel {...props} />
    </div>,
    document.body,
  );
}
