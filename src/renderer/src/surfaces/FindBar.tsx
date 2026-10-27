import type { ReactElement, ReactNode, RefObject } from "react";
import { ChevronDown, ChevronRight, ChevronUp, X } from "../chrome/icons";
import { Button } from "../components/ui/button";
import { GroupInput, InputGroup } from "../components/ui/input";
import { Kbd } from "../components/ui/kbd";
import { Toggle } from "../components/ui/toggle";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import { ALT, MOD, SHIFT } from "../lib/platform";

export type CountState = "idle" | "ok" | "empty" | "invalid";

export type FindFlag = "caseSensitive" | "wholeWord" | "regexp";

export type FindBarState = {
  search: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
  replaceVisible: boolean;
  count: { text: string; state: CountState };
};

export type FindBarProps = FindBarState & {
  searchRef: RefObject<HTMLInputElement | null>;
  replaceRef: RefObject<HTMLInputElement | null>;
  onSearch(value: string): void;
  onReplace(value: string): void;
  onToggle(flag: FindFlag): void;
  onToggleReplace(): void;
  onPrev(): void;
  onNext(): void;
  onClose(): void;
  onReplaceNext(): void;
  onReplaceAll(): void;
  /** The native event, for CodeMirror's scope handlers (⌘G, Esc, Enter). */
  onKeyDown(event: KeyboardEvent): void;
  onCompositionStart(): void;
  onCompositionEnd(): void;
};

/** The count beside the query: nothing until there is one, then the match
 *  in view of the total, "7+" past the cap. */
export function countLabel({
  value,
  valid,
  current,
  total,
  capped,
}: {
  value: string;
  valid: boolean;
  current: number;
  total: number;
  capped: boolean;
}): { text: string; state: CountState } {
  if (!value) return { text: "", state: "idle" };
  if (!valid) return { text: "Invalid regex", state: "invalid" };
  if (total === 0) return { text: "No results", state: "empty" };
  const suffix = capped ? "+" : "";
  return { text: current > 0 ? `${current} of ${total}${suffix}` : `${total}${suffix}`, state: "ok" };
}

/** Text fields that are code, not prose: no browser help. */
const FIELD_ATTRS = { autoComplete: "off", autoCorrect: "off", autoCapitalize: "off", spellCheck: false } as const;

const FLAGS: { flag: FindFlag; face: string; label: string; keys: string }[] = [
  { flag: "caseSensitive", face: "Aa", label: "Match case", keys: `${ALT}C` },
  { flag: "wholeWord", face: "ab", label: "Match whole word", keys: `${ALT}W` },
  { flag: "regexp", face: ".*", label: "Use regular expression", keys: `${ALT}R` },
];

/**
 * The editor's ⌘F panel (rendered by editorSearch.ts's FindPanel into
 * CodeMirror's panel node). It is opened from the keyboard, so it has no
 * entrance or exit motion; its buttons never take focus from the fields.
 */
export function FindBar(props: FindBarProps) {
  const { count, replaceVisible } = props;
  const missed = count.state === "empty" || count.state === "invalid";
  return (
    <TooltipProvider>
      <div
        className="flex items-start gap-1 rounded-xl border border-border bg-popover p-1.5 text-foreground shadow-overlay"
        onKeyDown={(event) => props.onKeyDown(event.nativeEvent)}
      >
        <Hint
          label="Toggle replace"
          keys={`${MOD}${ALT}F`}
          face={
            <ChevronRight
              className={cn(
                "transition-[rotate] duration-(--dur-fast) ease-(--ease-out) motion-reduce:transition-none",
                replaceVisible && "rotate-90",
              )}
            />
          }
          control={
            <Button
              variant="ghost"
              size="icon-xs"
              tabIndex={-1}
              aria-label="Toggle replace"
              aria-expanded={replaceVisible}
              className="mt-0.5 aria-expanded:not-hover:bg-transparent"
              onClick={props.onToggleReplace}
            />
          }
        />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1">
            <InputGroup className={cn("h-7 w-60 min-w-36 gap-1 pe-2", missed && "border-destructive")}>
              <GroupInput
                ref={props.searchRef}
                main-field="true"
                aria-label="Find"
                aria-invalid={missed || undefined}
                placeholder="Find"
                className="font-mono text-[12px]"
                value={props.search}
                onChange={(event) => props.onSearch(event.currentTarget.value)}
                onCompositionStart={props.onCompositionStart}
                onCompositionEnd={props.onCompositionEnd}
                {...FIELD_ATTRS}
              />
              <span
                data-count={count.state}
                className={cn("shrink-0 text-[12px] tabular-nums", missed ? "text-destructive" : "text-muted-foreground")}
              >
                {count.text}
              </span>
            </InputGroup>
            <div data-find-controls className="flex shrink-0 items-center gap-1">
              {FLAGS.map(({ flag, face, label, keys }) => (
                <Hint
                  key={flag}
                  label={label}
                  keys={keys}
                  face={face}
                  control={
                    <Toggle
                      size="sm"
                      tabIndex={-1}
                      aria-label={label}
                      pressed={props[flag]}
                      onPressedChange={() => props.onToggle(flag)}
                      className="font-mono text-[11px]"
                    />
                  }
                />
              ))}
              <Hint
                label="Previous match"
                keys={`${MOD}${SHIFT}G`}
                face={<ChevronUp />}
                control={<Button variant="ghost" size="icon-xs" tabIndex={-1} aria-label="Previous match" onClick={props.onPrev} />}
              />
              <Hint
                label="Next match"
                keys={`${MOD}G`}
                face={<ChevronDown />}
                control={<Button variant="ghost" size="icon-xs" tabIndex={-1} aria-label="Next match" onClick={props.onNext} />}
              />
              <Hint
                label="Close"
                keys="Esc"
                face={<X />}
                control={<Button variant="ghost" size="icon-xs" tabIndex={-1} aria-label="Close" onClick={props.onClose} />}
              />
            </div>
          </div>
          {replaceVisible ? (
            <div className="flex flex-wrap items-center gap-1">
              <InputGroup className="h-7 w-60 min-w-36">
                <GroupInput
                  ref={props.replaceRef}
                  aria-label="Replace"
                  placeholder="Replace"
                  className="font-mono text-[12px]"
                  value={props.replace}
                  onChange={(event) => props.onReplace(event.currentTarget.value)}
                  {...FIELD_ATTRS}
                />
              </InputGroup>
              <div className="flex shrink-0 items-center gap-1">
                <Button variant="ghost" size="xs" tabIndex={-1} onClick={props.onReplaceNext}>
                  Replace
                </Button>
                <Button variant="ghost" size="xs" tabIndex={-1} onClick={props.onReplaceAll}>
                  Replace all
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </TooltipProvider>
  );
}

/** A control with its name and shortcut on hover. */
function Hint({ label, keys, face, control }: { label: string; keys: string; face: ReactNode; control: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={control}>{face}</TooltipTrigger>
      <TooltipContent>
        {label}
        <Kbd size="sm">{keys}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
