import { useMemo } from "react";
import { useEnvironments } from "../../../lib/connection/status";
import { useSessionMetasWhen } from "../../../lib/tcserver/store";
import { useProjects, useWorkspaces } from "../../../lib/tcserver/workspaces";
import { useMetaById } from "../../../lib/threads/agents";
import { AddThreadDialog } from "./AddThreadDialog";
import { AdoptThreadDialog } from "./AdoptThreadDialog";
import { adoptCandidates, pairedProjectIds } from "./boardActions";
import { adoptThreads, masterChildrenOf } from "./useMasterModel";

/**
 * The batch's two add dialogs for one master, whoever opens them: the
 * board's + Thread and the master's thread menu (New batch thread…, Add
 * existing thread…), so a master with no board yet can still fill it. The
 * add sheet offers the batch's children as `after` siblings; the adopt
 * dialog the project's roots (and its paired copies') in no batch.
 */
export function BatchAddDialog({ masterId, kind, onClose }: { masterId: string; kind: "new" | "adopt"; onClose: () => void }) {
  const master = useMetaById(masterId);
  const metas = useSessionMetasWhen(true);
  const workspaces = useWorkspaces();
  const projects = useProjects();
  const environments = useEnvironments();
  const siblings = useMemo(() => masterChildrenOf(metas, masterId), [metas, masterId]);
  const candidates = useMemo(() => {
    if (kind !== "adopt" || !master) return [];
    return adoptCandidates(metas, master, pairedProjectIds(master, workspaces, projects));
  }, [kind, metas, master, workspaces, projects]);
  if (!master) return null;
  if (kind === "new") return <AddThreadDialog master={master} siblings={siblings} onClose={onClose} />;
  return (
    <AdoptThreadDialog
      candidates={candidates}
      hostName={(id) => environments.find((e) => e.id === id)?.name ?? id}
      onClose={onClose}
      onAdopt={(threads) => adoptThreads(master, threads)}
    />
  );
}
