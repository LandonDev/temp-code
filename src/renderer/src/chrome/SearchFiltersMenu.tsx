import { useMemo } from "react";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { SEARCH_KINDS, type SearchKind } from "../lib/appSearch";
import type { Environment } from "../lib/connection/types";
import { hostToken, hostsMatching, parseSearchQuery, setQueryToken } from "../lib/crossHostSearch";
import { cn } from "../lib/cn";
import { projectName } from "../lib/paths";
import { IS_MAC } from "../lib/platform";
import { looksLikeProject } from "../lib/recents";
import { ListFilter } from "./icons";

const KIND_LABEL: Record<SearchKind, string> = {
  thread: "Threads",
  file: "Files",
  note: "Notes",
  project: "Projects",
};

/**
 * The search field's filters as a menu. The typed query stays the one
 * truth: the menu reads the `type:`, `host:` and `project:` tokens out of
 * it, and ticking a box rewrites that token in the field. No token means
 * every box of its group is ticked; ticking the last one back removes it.
 */
export function SearchFiltersMenu({
  query,
  onQueryChange,
  environments,
  cwd,
  onClosed,
}: {
  query: string;
  onQueryChange: (next: string) => void;
  environments: readonly Environment[];
  cwd: string;
  onClosed?: () => void;
}) {
  const parsed = useMemo(() => parseSearchQuery(query), [query]);
  const filtered = parsed.types !== null || parsed.hosts !== null || parsed.project !== null;
  const types = parsed.types ?? SEARCH_KINDS;
  const hostIds = new Set(hostsMatching(parsed.hosts, environments, IS_MAC).map((env) => env.id));
  const here = looksLikeProject(cwd) ? projectName(cwd) : null;
  // A token cannot hold a space, so a name with one cannot be written.
  const hereToken = here && !/\s/.test(here) ? here.toLowerCase() : null;
  const projectValue = parsed.project === null ? "any" : parsed.project === hereToken ? "here" : "other";

  const toggleType = (kind: SearchKind, on: boolean) => {
    const next = SEARCH_KINDS.filter((k) => (k === kind ? on : types.includes(k)));
    onQueryChange(setQueryToken(query, "type", next.length === SEARCH_KINDS.length ? null : next));
  };
  const toggleHost = (id: string, on: boolean) => {
    const next = environments.filter((env) => (env.id === id ? on : hostIds.has(env.id)));
    onQueryChange(
      setQueryToken(
        query,
        "host",
        next.length === environments.length ? null : next.map((env) => hostToken(env, environments, IS_MAC)),
      ),
    );
  };
  const setProject = (value: string) => {
    if (value === "any") onQueryChange(setQueryToken(query, "project", null));
    else if (value === "here" && hereToken) onQueryChange(setQueryToken(query, "project", [hereToken]));
  };

  return (
    <DropdownMenu onOpenChange={(open) => (open ? undefined : onClosed?.())}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Filters"
                  data-tauri-drag-region="false"
                  className={cn(filtered ? "text-foreground" : "text-muted-foreground")}
                />
              }
            />
          }
        >
          <ListFilter />
        </TooltipTrigger>
        <TooltipContent>Filters</TooltipContent>
      </Tooltip>
      <DropdownMenuContent size="sm" align="end" className="min-w-44">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Type</DropdownMenuLabel>
          {SEARCH_KINDS.map((kind) => (
            <DropdownMenuCheckboxItem
              key={kind}
              checked={types.includes(kind)}
              onCheckedChange={(on) => toggleType(kind, on)}
              closeOnClick={false}
            >
              {KIND_LABEL[kind]}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
        {environments.length > 1 ? (
          <DropdownMenuGroup className="mt-2">
            <DropdownMenuLabel>Host</DropdownMenuLabel>
            {environments.map((env) => (
              <DropdownMenuCheckboxItem
                key={env.id}
                checked={hostIds.has(env.id)}
                onCheckedChange={(on) => toggleHost(env.id, on)}
                closeOnClick={false}
              >
                {env.name}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
        ) : null}
        <DropdownMenuGroup className="mt-2">
          <DropdownMenuLabel>Project</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={projectValue} onValueChange={(value) => setProject(String(value))}>
            <DropdownMenuRadioItem value="any" closeOnClick={false}>
              Any
            </DropdownMenuRadioItem>
            {hereToken ? (
              <DropdownMenuRadioItem value="here" closeOnClick={false}>
                {here}
              </DropdownMenuRadioItem>
            ) : null}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
