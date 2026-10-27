import { useEffect, useState, type ReactNode } from "react";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";

export type MarkdownViewMode = "preview" | "source";

const remembered = new Map<string, MarkdownViewMode>();

export function useMarkdownMode(
  key: string,
): [MarkdownViewMode, (mode: MarkdownViewMode) => void] {
  const [mode, setMode] = useState<MarkdownViewMode>(
    () => remembered.get(key) ?? "preview",
  );

  useEffect(() => {
    setMode(remembered.get(key) ?? "preview");
  }, [key]);

  return [
    mode,
    (next) => {
      remembered.set(key, next);
      setMode(next);
    },
  ];
}

type ToggleProps = {
  mode: MarkdownViewMode;
  onChange: (mode: MarkdownViewMode) => void;
};

/** Preview or source: one joined bar of two toggles, floating at the
 *  pane's top right. */
export function MarkdownModeToggle({ mode, onChange }: ToggleProps) {
  return (
    <ToggleGroup
      spacing={0}
      size="sm"
      aria-label="Markdown view"
      value={[mode]}
      onValueChange={(next: unknown[]) => {
        const picked = next[0] as MarkdownViewMode | undefined;
        if (picked) onChange(picked);
      }}
      className="rounded-lg border border-border bg-popover p-0.5"
    >
      <ToggleGroupItem value="preview" size="sm" className="h-6 px-2 text-xs">
        Preview
      </ToggleGroupItem>
      <ToggleGroupItem value="source" size="sm" className="h-6 px-2 text-xs">
        Source
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

type ShellProps = {
  mode: MarkdownViewMode;
  onModeChange: (mode: MarkdownViewMode) => void;
  preview: ReactNode;
  source: ReactNode;
};

export function MarkdownViewShell({
  mode,
  onModeChange,
  preview,
  source,
}: ShellProps) {
  return (
    <div className="relative min-h-0 min-w-0 flex-1">
      <div className="pointer-events-none absolute top-2 right-2 z-20">
        <div className="pointer-events-auto">
          <MarkdownModeToggle mode={mode} onChange={onModeChange} />
        </div>
      </div>
      <div
        className={
          mode === "preview"
            ? "absolute inset-0"
            : "pointer-events-none invisible absolute inset-0"
        }
      >
        {preview}
      </div>
      <div
        className={
          mode === "source"
            ? "absolute inset-0"
            : "pointer-events-none invisible absolute inset-0"
        }
      >
        {source}
      </div>
    </div>
  );
}
