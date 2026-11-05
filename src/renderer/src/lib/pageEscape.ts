import { useEffect, useRef } from "react";

/** What Escape in a page's own text field does before the page closes:
 *  `undo` puts back the value the field held when it took focus and lets go
 *  (Settings, where an edit commits on blur); `blur` only lets go, keeping
 *  the text (a note or a comment that saves as it is typed); `close` closes
 *  the page from the field (Search, whose one field is the page). */
export type FieldEscape = "undo" | "blur" | "close";

/** Popups that own their Escape: a dialog or a confirm, a menu, a select or
 *  a popover. Escape inside one never reaches the page behind it. */
const INNER_LAYER =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [data-slot=select-content], [data-slot=popover-content], [data-slot=dropdown-menu-content]';
const OPEN_POPUP = '[data-slot=select-content][data-open], [role="alertdialog"][data-open], [role="menu"][data-open]';

/** True when a layer above the page should take this Escape. */
export function innerLayerOwnsEscape(target: EventTarget | null): boolean {
  if (target instanceof Element && target.closest(INNER_LAYER)) return true;
  return !!document.querySelector(OPEN_POPUP);
}

type TextField = HTMLInputElement | HTMLTextAreaElement;

const NOT_TEXT = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"]);

export function isTextField(el: Element): el is TextField {
  return el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !NOT_TEXT.has(el.type));
}

/** Sets a field's value the way typing would, so React's onChange hears it. */
function setFieldValue(field: TextField, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Escape belongs to the innermost layer: a page (Settings, Notes, Inbox,
 * Search) closes on Escape only when no dialog, confirm, menu, select or
 * popover took it, and a focused field takes it first as `fields` says.
 * One window listener in the capture phase, so the page hears it before the
 * app's own Escape handling.
 */
export function usePageEscape(onClose: () => void, { enabled = true, fields }: { enabled?: boolean; fields: FieldEscape }) {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (!enabled) return;
    // The value a field held when it took focus, so Escape can put it back.
    const entered = new WeakMap<Element, string>();
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Element | null;
      if (target && isTextField(target)) entered.set(target, target.value);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (innerLayerOwnsEscape(event.target)) return;
      const target = event.target as Element | null;
      event.preventDefault();
      event.stopPropagation();
      if (target && fields !== "close" && isTextField(target)) {
        if (fields === "undo") {
          const before = entered.get(target);
          if (before !== undefined && before !== target.value) setFieldValue(target, before);
        }
        target.blur();
        return;
      }
      if (target instanceof HTMLSelectElement) {
        target.blur();
        return;
      }
      close.current();
    };
    window.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [enabled, fields]);
}
