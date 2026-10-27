import { registry } from "../lib/connection";
import { environmentOfCwd } from "../lib/tcserver/projects";
import { CaseSensitive, ChevronLeft, Regex, WholeWord } from "./icons";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Item } from "../components/ui/item";
import { Spinner } from "../components/ui/spinner";
import { Toggle } from "../components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import {
  searchProject,
  type OpenFileFn,
  type ProjectSearchMatch,
} from "../lib/search";
import { FileTypeIcon } from "./FileTypeIcon";
import { MatchText } from "./MatchText";
import { EmptyState } from "../surfaces/SurfaceSkeleton";

type Props = {
  cwd: string;
  focusToken?: number;
  onOpenFile: OpenFileFn;
  onClose: () => void;
};

type MatchGroup = {
  path: string;
  relative: string;
  name: string;
  matches: ProjectSearchMatch[];
};

export function ProjectSearch({
  cwd,
  focusToken = 0,
  onOpenFile,
  onClose,
}: Props) {
  const environmentId = environmentOfCwd(cwd) ?? registry.primary().environmentId;
  const inputRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [query, setQuery] = useState("");
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<ProjectSearchMatch[]>([]);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    if (!focusToken) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || !cwd || cwd === "~") {
      setMatches([]);
      setTruncated(false);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void searchProject(environmentId, {
        cwd,
        query: trimmed,
        caseSensitive,
        wholeWord,
        regex,
        include: include.trim() || undefined,
        exclude: exclude.trim() || undefined,
      })
        .then((result) => {
          if (cancelled) return;
          setMatches(result.matches);
          setTruncated(result.truncated);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setMatches([]);
          setTruncated(false);
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        });
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [environmentId, caseSensitive, cwd, exclude, include, query, regex, wholeWord]);

  const groups = useMemo(() => groupMatches(matches), [matches]);
  const matchCount = matches.length;
  const fileCount = groups.length;

  const openMatch = (match: ProjectSearchMatch) => {
    onOpenFile(match.path, { line: match.line, column: match.column });
  };

  const onQueryKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Enter" && matches[0]) {
      event.preventDefault();
      openMatch(matches[0]);
    }
  };

  if (!cwd || cwd === "~") {
    return <EmptyState title="No project folder" />;
  }

  const trimmed = query.trim();
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-1.5 pt-1.5">
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label="Back to files" onClick={onClose} />}
          >
            <ChevronLeft />
          </TooltipTrigger>
          <TooltipContent>Back to files</TooltipContent>
        </Tooltip>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-muted-foreground">
          Search in files
        </span>
      </div>
      <div className="flex shrink-0 flex-col gap-2 p-3">
        <div className="relative">
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onQueryKeyDown}
            placeholder="Search"
            aria-label="Search"
            spellCheck={false}
            className="pe-[84px]"
          />
          <div className="absolute end-1 top-1/2 flex -translate-y-1/2 items-center">
            <OptionToggle label="Match case" pressed={caseSensitive} onPressedChange={setCaseSensitive}>
              <CaseSensitive />
            </OptionToggle>
            <OptionToggle label="Match whole word" pressed={wholeWord} onPressedChange={setWholeWord}>
              <WholeWord />
            </OptionToggle>
            <OptionToggle label="Use regular expression" pressed={regex} onPressedChange={setRegex}>
              <Regex />
            </OptionToggle>
          </div>
        </div>
        <Input
          value={include}
          onChange={(event) => setInclude(event.target.value)}
          placeholder="Files to include"
          aria-label="Files to include"
          spellCheck={false}
          className="h-7 text-[12px]"
        />
        <Input
          value={exclude}
          onChange={(event) => setExclude(event.target.value)}
          placeholder="Files to exclude"
          aria-label="Files to exclude"
          spellCheck={false}
          className="h-7 text-[12px]"
        />
      </div>

      {trimmed ? (
        <div aria-live="polite" className="flex shrink-0 items-center gap-2 px-3 pb-2 text-[12px] text-muted-foreground">
          {loading ? (
            <>
              <Spinner className="size-3.5" />
              <span>Searching…</span>
            </>
          ) : error ? (
            <span className="text-destructive">{error}</span>
          ) : matchCount === 0 ? (
            <span>No results</span>
          ) : (
            <span>
              {truncated ? "First " : ""}
              {truncated ? `${matchCount} results` : plural(matchCount, "result")} in {plural(fileCount, "file")}
            </span>
          )}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-none px-1.5 pb-1.5">
        {groups.map((group) => {
          const folder = group.relative.slice(0, Math.max(0, group.relative.length - group.name.length - 1));
          return (
            <section key={group.path} aria-label={group.relative}>
              <div className="flex h-7 items-center gap-2 px-1.5">
                <FileTypeIcon name={group.name} isDir={false} size={16} />
                <span className="shrink-0 truncate text-[13px] text-foreground">{group.name}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{folder}</span>
                <span data-match-count className="shrink-0 text-[12px] text-muted-foreground tabular-nums">
                  {group.matches.length}
                </span>
              </div>
              <ul>
                {group.matches.map((match) => (
                  <li key={`${match.path}:${match.line}:${match.column}`}>
                    <Item
                      size="xs"
                      className="flex-nowrap items-start gap-2 rounded-md px-1.5 py-0.5 text-left transition-none hover:bg-foreground/5"
                      render={<button type="button" onClick={() => openMatch(match)} />}
                    >
                      <span className="w-7 shrink-0 text-right font-mono text-[11px] leading-5 text-muted-foreground tabular-nums">
                        {match.line}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px] leading-5 text-foreground/80">
                        <MatchText
                          text={match.preview.trimEnd()}
                          query={trimmed}
                          caseSensitive={caseSensitive}
                          regex={regex}
                        />
                      </span>
                    </Item>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function OptionToggle({
  label,
  pressed,
  onPressedChange,
  children,
}: {
  label: string;
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Toggle size="xs" aria-label={label} pressed={pressed} onPressedChange={onPressedChange} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function groupMatches(matches: ProjectSearchMatch[]): MatchGroup[] {
  const byPath = new Map<string, MatchGroup>();
  for (const match of matches) {
    const existing = byPath.get(match.path);
    if (existing) {
      existing.matches.push(match);
      continue;
    }
    byPath.set(match.path, {
      path: match.path,
      relative: match.relative,
      name: match.relative.split("/").pop() ?? match.relative,
      matches: [match],
    });
  }
  return [...byPath.values()];
}

