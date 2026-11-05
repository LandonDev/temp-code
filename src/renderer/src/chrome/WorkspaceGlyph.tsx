import { useEffect, useState } from "react";
import { cn } from "../lib/cn";
import { projectLogoSrc } from "../lib/projectLogos";
import {
  loadTabGroupColors,
  loadTabGroupCustomColors,
  loadTabGroupLogos,
  loadTabGroupMascots,
  resolveTabGroupColor,
  resolveTabGroupLogo,
  resolveTabGroupMascot,
  TAB_GROUP_LOGOS_CHANGED,
  tabGroupLogoDisplayRevision,
} from "../lib/tabGroups";
import { useTabGroupLogos } from "../hooks/useTabGroupLogos";
import { projectName } from "../lib/paths";
import { useWorkspaceIcon, useWorkspaces, workspaceByPath, workspaceLabelKey } from "../lib/tcserver/workspaces";
import { GitHub, GitLab } from "./icons";
import { ProjectMascot } from "./ProjectMascot";

/** What Customize set for a workspace, resolved: the logo file, the mascot
 *  picked on purpose (null: the one hashed from the key) and its colour. */
export type WorkspaceLook = {
  logoPath: string | null;
  mascotName: string | null;
  color: string;
};

/** A workspace's look from the saved overrides, keyed like the rail
 *  (`workspaceLabelKey`: the link leader's workspace id, else the folder's
 *  name). Callers that hold the records in state pass them; the rest read
 *  them at render. */
export function workspaceLook(
  key: string,
  saved: {
    logos?: Record<string, string>;
    mascots?: Record<string, string>;
    colors?: Record<string, number>;
    customColors?: Record<string, string>;
  } = {},
): WorkspaceLook {
  return {
    logoPath: resolveTabGroupLogo(key, saved.logos ?? loadTabGroupLogos()),
    mascotName: resolveTabGroupMascot(key, saved.mascots ?? loadTabGroupMascots()),
    color: resolveTabGroupColor(key, saved.colors ?? loadTabGroupColors(), saved.customColors ?? loadTabGroupCustomColors(), key),
  };
}

/**
 * A workspace's one glyph, the same in the rail, Search, Inbox, Notes and
 * the folder picker: the logo Customize set, else the repo's icon from the
 * workspace's host (unless a mascot was picked on purpose), else the mascot
 * in the workspace's colour. Never animated and never recoloured by state.
 */
export function WorkspaceGlyph({
  logoPath,
  mascotName,
  color,
  projectKey,
  workspaceId,
  className,
  mascotClassName,
}: WorkspaceLook & {
  /** The key the hashed mascot is picked from. */
  projectKey: string;
  /** The workspace whose host answers its repo icon; null for none. */
  workspaceId?: string | null;
  className?: string;
  /** The mascot's box, when it sits smaller than an image (Inbox, Notes). */
  mascotClassName?: string;
}) {
  const revision = useLogoRevision();
  const serverIcon = useWorkspaceIcon(workspaceId);
  const logo = projectLogoSrc(logoPath);
  const repo = mascotName ? null : (serverIcon?.dataUrl ?? null);
  return (
    <WorkspaceGlyphView
      sources={logo && repo ? [logo, repo] : logo ? [logo] : repo ? [repo] : NONE}
      revision={revision}
      host={mascotName ? null : (serverIcon?.host ?? null)}
      mascot={{ project: projectKey, name: mascotName, color }}
      className={className}
      mascotClassName={mascotClassName}
    />
  );
}

/**
 * The glyph from what is already resolved (the fixtures draw it so): the
 * first image of `sources` that has not failed, else the host's mark, else
 * the mascot. A file image draws nothing while it loads (the box keeps its
 * size, so the name never moves); a data URL is already here and draws at
 * once. An image that fails gives way to the next.
 */
export function WorkspaceGlyphView({
  sources,
  revision = 0,
  host,
  mascot,
  className = "size-4 shrink-0",
  mascotClassName,
}: {
  sources: readonly string[];
  /** Bumps when a logo file is replaced under the same name. */
  revision?: number;
  host?: string | null;
  mascot: { project: string; name: string | null; color: string };
  className?: string;
  mascotClassName?: string;
}) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(EMPTY);
  const [loaded, setLoaded] = useState<string | null>(null);
  const src = sources.find((each) => !failed.has(each)) ?? null;
  if (src) {
    const shown = loaded === src || src.startsWith("data:");
    return (
      <img
        key={`${src}:${revision}`}
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        data-workspace-logo
        ref={(el) => {
          // A cached image can finish before React hears its load.
          if (!shown && el?.complete && el.naturalWidth > 0) setLoaded(src);
        }}
        onLoad={shown ? undefined : () => setLoaded(src)}
        onError={() => setFailed((prev) => new Set(prev).add(src))}
        className={cn(
          "rounded-sm object-cover outline -outline-offset-1 outline-image-outline",
          !shown && "invisible",
          className,
        )}
      />
    );
  }
  const HostMark = host === "github" ? GitHub : host === "gitlab" ? GitLab : null;
  if (HostMark) return <HostMark data-workspace-host-mark className={className} />;
  return (
    <ProjectMascot project={mascot.project} color={mascot.color} name={mascot.name} className={mascotClassName ?? className} />
  );
}

const NONE: readonly string[] = [];
const EMPTY: ReadonlySet<string> = new Set();

/** Bumps when a logo file is replaced under the same name. */
function useLogoRevision(): number {
  const [revision, setRevision] = useState(tabGroupLogoDisplayRevision);
  useEffect(() => {
    const refresh = () => setRevision(tabGroupLogoDisplayRevision());
    window.addEventListener(TAB_GROUP_LOGOS_CHANGED, refresh);
    return () => window.removeEventListener(TAB_GROUP_LOGOS_CHANGED, refresh);
  }, []);
  return revision;
}

/** The glyph of the workspace a folder belongs to, for a surface that holds
 *  a path alone (the folder picker, a Search project hit): the key and the
 *  repo icon come from the catalog as the rail's do; a folder no workspace
 *  knows keys by its name. */
export function FolderGlyph({
  path,
  className,
  mascotClassName,
}: {
  path: string;
  className?: string;
  mascotClassName?: string;
}) {
  const workspaces = useWorkspaces();
  const logos = useTabGroupLogos();
  const workspaceId = workspaceByPath(workspaces, path)?.id ?? null;
  const key = workspaceLabelKey(workspaces, path, projectName(path));
  const look = workspaceLook(key, { logos });
  return (
    <WorkspaceGlyph
      logoPath={look.logoPath}
      mascotName={look.mascotName}
      color={look.color}
      projectKey={key}
      workspaceId={workspaceId}
      className={className}
      mascotClassName={mascotClassName}
    />
  );
}
