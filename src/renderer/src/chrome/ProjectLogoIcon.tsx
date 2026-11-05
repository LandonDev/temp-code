import { Folder, GitHub, GitLab, type IconComponent } from "./icons";
import { useEffect, useState } from "react";
import { cn } from "../lib/cn";
import { projectLogoSrc } from "../lib/projectLogos";
import { useWorkspaceIcon } from "../lib/tcserver/workspaces";
import {
  TAB_GROUP_LOGOS_CHANGED,
  tabGroupLogoDisplayRevision,
} from "../lib/tabGroups";

type Props = {
  path?: string | null;
  /** Server workspace: its repo icon or host mark fills in when no logo is set. */
  workspaceId?: string | null;
  className?: string;
  imageClassName?: string;
  fallback?: IconComponent;
};

export function ProjectLogoIcon({
  path,
  workspaceId,
  className = "size-4 shrink-0",
  imageClassName,
  fallback: Fallback = Folder,
}: Props) {
  const [revision, setRevision] = useState(tabGroupLogoDisplayRevision);

  useEffect(() => {
    const refresh = () => setRevision(tabGroupLogoDisplayRevision());
    window.addEventListener(TAB_GROUP_LOGOS_CHANGED, refresh);
    return () => window.removeEventListener(TAB_GROUP_LOGOS_CHANGED, refresh);
  }, []);

  const serverIcon = useWorkspaceIcon(workspaceId);
  const src = projectLogoSrc(path) ?? serverIcon?.dataUrl ?? null;
  if (src) {
    return (
      <img
        key={`${path ?? ""}:${revision}`}
        src={src}
        alt=""
        className={cn("rounded-sm object-cover outline -outline-offset-1 outline-image-outline", className, imageClassName)}
      />
    );
  }
  const HostMark =
    serverIcon?.host === "github" ? GitHub : serverIcon?.host === "gitlab" ? GitLab : null;
  if (HostMark) {
    return <HostMark className={className} />;
  }
  return (
    <Fallback className={className} />
  );
}
