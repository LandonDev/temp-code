import { useMemo } from "react";
import { Button } from "../components/ui/button";
import { SEARCH_KINDS, type SearchKind } from "../lib/appSearch";
import type { Environment } from "../lib/connection/types";
import { hostToken, hostsMatching, parseSearchQuery, setQueryToken } from "../lib/crossHostSearch";
import { cn } from "../lib/cn";
import { platformOf } from "../lib/hostPlatform";
import { projectName } from "../lib/paths";
import { IS_MAC } from "../lib/platform";
import { looksLikeProject } from "../lib/recents";
import { CloudServer, File, Folder, Laptop, ListFilter, MessageSquare, StickyNote } from "./icons";
import { RowsMenu, type MenuIcon, type MenuRow } from "./menuRows";

const KIND_LABEL: Record<SearchKind, string> = {
  thread: "Threads",
  file: "Files",
  note: "Notes",
  project: "Projects",
};

/** The glyph each kind's hits lead with in the results. */
const KIND_ICON: Record<SearchKind, MenuIcon> = {
  thread: MessageSquare,
  file: File,
  note: StickyNote,
  project: Folder,
};

/**
 * The search field's filters as a menu (`RowsMenu`, the Inbox filter menu's
 * shape). The typed query stays the one truth: the menu reads the `type:`,
 * `host:` and `project:` tokens out of it, and ticking a box rewrites that
 * token in the field. No token means every box of its group is ticked;
 * the last ticked box of a group stays, since none would read as every one.
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

  // A written token ends with a space so the next typed word stays a word.
  const write = (next: string) => onQueryChange(next ? `${next} ` : "");
  const toggleType = (kind: SearchKind) => {
    const on = !types.includes(kind);
    const next = SEARCH_KINDS.filter((k) => (k === kind ? on : types.includes(k)));
    write(setQueryToken(query, "type", next.length === SEARCH_KINDS.length ? null : next));
  };
  const toggleHost = (id: string) => {
    const on = !hostIds.has(id);
    const next = environments.filter((env) => (env.id === id ? on : hostIds.has(env.id)));
    write(
      setQueryToken(
        query,
        "host",
        next.length === environments.length ? null : next.map((env) => hostToken(env, environments, IS_MAC)),
      ),
    );
  };
  const setProject = (value: "any" | "here") => {
    if (value === "any") write(setQueryToken(query, "project", null));
    else if (hereToken) write(setQueryToken(query, "project", [hereToken]));
  };

  const rows = (): MenuRow[] => {
    const out: MenuRow[] = [{ kind: "label", label: "Type" }];
    for (const kind of SEARCH_KINDS) {
      const last = types.length === 1 && types.includes(kind);
      out.push({
        kind: "item",
        id: `type:${kind}`,
        label: KIND_LABEL[kind],
        icon: KIND_ICON[kind],
        checked: types.includes(kind),
        keepOpen: true,
        disabled: last,
        reason: last ? "Search needs one type" : undefined,
      });
    }
    if (environments.length > 1) {
      out.push({ kind: "sep" }, { kind: "label", label: "Host" });
      for (const env of environments) {
        const last = hostIds.size === 1 && hostIds.has(env.id);
        out.push({
          kind: "item",
          id: `host:${env.id}`,
          label: env.name,
          icon: platformOf(env.id) === "darwin" ? Laptop : CloudServer,
          checked: hostIds.has(env.id),
          keepOpen: true,
          disabled: last,
          reason: last ? "Search needs one host" : undefined,
        });
      }
    }
    out.push({ kind: "sep" }, { kind: "label", label: "Project" });
    out.push({ kind: "item", id: "project:any", label: "Any", icon: Folder, checked: projectValue === "any", keepOpen: true });
    if (hereToken && here) {
      out.push({ kind: "item", id: "project:here", label: here, icon: Folder, checked: projectValue === "here", keepOpen: true });
    }
    return out;
  };

  const pick = (id: string) => {
    const [group, value] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)];
    if (group === "type") toggleType(value as SearchKind);
    else if (group === "host") toggleHost(value);
    else if (group === "project") setProject(value === "here" ? "here" : "any");
  };

  return (
    <RowsMenu
      trigger={
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Filters"
          data-tauri-drag-region="false"
          className={cn(filtered ? "text-foreground" : "text-muted-foreground")}
        >
          <ListFilter />
        </Button>
      }
      label="Search filters"
      tip={{ label: "Filters" }}
      rows={rows}
      onPick={pick}
      onOpenChange={(open) => (open ? undefined : onClosed?.())}
      align="end"
      className="w-48"
    />
  );
}
