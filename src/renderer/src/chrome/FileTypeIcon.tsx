import { useSyncExternalStore } from "react";

type Props = {
  name: string;
  isDir: boolean;
  isOpen?: boolean;
  isRoot?: boolean;
  size?: number;
};

type IconPack = typeof import("react-material-icon-theme");

/**
 * The Material icon pack inlines every glyph as a component — ~1.1 MB, the
 * single largest thing in the boot chunk, for 16px decorations. Load it after
 * first paint and hold a same-sized blank until it lands, so the app starts
 * without it and nothing reflows when it arrives.
 */
let pack: IconPack | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function loadPack() {
  if (pack || loading) return;
  loading = import("react-material-icon-theme").then((mod) => {
    pack = mod;
    for (const listener of listeners) listener();
  });
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  loadPack();
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot() {
  return pack;
}

/** VS Code Material Icon Theme — filename maps to the matching icon. */
export function FileTypeIcon({
  name,
  isDir,
  isOpen = false,
  isRoot = false,
  size = 16,
}: Props) {
  const icons = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const svg = icons
    ? icons.getIconSvg(isDir ? icons.getFolderIcon({ folderName: name, isOpen, isRoot }) : resolveFileIcon(icons, name))
    : null;
  // The glyph is drawn here, not by the pack's components: they always write
  // a native `title` ("typescript icon"), and the row beside it already names the file.
  // The empty box before the pack loads sits exactly where the glyph will, so nothing moves when it lands.
  return (
    <span
      aria-hidden
      className="material-icon inline-block shrink-0 align-middle"
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}

/**
 * The package only checks `fileExtension` when that prop is set — it does not
 * peel an extension off `fileName`. Try the full name, then compound suffixes
 * (`d.ts`, then `ts`) so `.rs` / `.toml` / `.json` resolve like VS Code.
 */
function resolveFileIcon(icons: IconPack, fileName: string): string {
  const key = fileName.toLowerCase();
  const fromName = icons.getFileIcon({
    fileName: key,
    fallback: "",
    iconPack: "",
  });
  if (fromName) return fromName;

  for (const ext of compoundExtensions(key)) {
    const fromExt = icons.getFileIcon({
      fileExtension: ext,
      fallback: "",
      iconPack: "",
    });
    if (fromExt) return fromExt;
  }

  return "file";
}

function compoundExtensions(fileName: string): string[] {
  const parts = fileName.split(".");
  const start = parts[0] === "" ? 1 : 0;
  const exts: string[] = [];
  for (let i = start + 1; i < parts.length; i++) {
    exts.push(parts.slice(i).join("."));
  }
  return exts;
}
