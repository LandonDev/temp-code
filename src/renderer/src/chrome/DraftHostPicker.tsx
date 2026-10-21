import { useRef, useState } from "react";
import { Check, ChevronDown } from "./icons";
import { Popover } from "./Popover";
import { toneOf } from "./EnvironmentSwitcher";
import { degradedFor, useEnvironmentStatuses, useEnvironments } from "../lib/connection";
import { rememberProjectHost } from "../lib/projectHostChoice";
import { clusterOfPath, useProjectClusters } from "../lib/projectMerge";
import { useSession, useSessionMeta } from "../lib/tcserver/store";
import { statusText } from "../surfaces/EnvironmentsSettings";

/**
 * Where a new thread starts, when its project is checked out on more than
 * one host: the composer's small host button, the switcher's pieces (dot,
 * name, chevron; a menu of the project's hosts with their connection
 * state). Shown only for an unsent draft in a merged project; a saved thread
 * moves through the header's host chip instead. Picking a host retargets
 * the draft to that checkout and is remembered for the project.
 */
export function DraftHostPicker({ sessionId, onPick }: { sessionId: string; onPick: (cwd: string) => void }) {
  const session = useSession(sessionId);
  const meta = useSessionMeta(sessionId);
  const view = useProjectClusters();
  const environments = useEnvironments();
  const statuses = useEnvironmentStatuses();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement | null>(null);
  if (!session || meta || session.blocks.length > 0 || session.projectId) return null;
  const cluster = clusterOfPath(view, session.cwd) ?? (session.workspaceId ? view.byWorkspaceId.get(session.workspaceId) : undefined);
  if (!cluster || cluster.hosts.length < 2) return null;
  const current = environments.find((e) => e.id === session.environmentId);
  if (!current) return null;
  const status = statuses.get(current.id);
  const now = Date.now();
  return (
    <>
      <button
        ref={button}
        type="button"
        data-draft-host-picker={current.id}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Start on ${current.name}`}
        title={`This thread will start on ${current.name}`}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-6 max-w-40 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[11px] ${open ? "bg-content/10 text-content" : "text-content/50 hover:bg-content/5 hover:text-content"}`}
      >
        <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${status ? toneOf(status, degradedFor(status, Number.POSITIVE_INFINITY) !== null) : "bg-content/25"}`} />
        <span className="min-w-0 flex-1 truncate">{current.name}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" strokeWidth={2} />
      </button>
      {open ? (
        <Popover anchor={button} side="top" align="start" width={240} onDismiss={() => setOpen(false)} className="flex flex-col p-1" autoFocus>
          <div role="menu" aria-label="Start this thread on" className="flex flex-col">
            {cluster.hosts.map((id) => {
              const env = environments.find((e) => e.id === id);
              const s = statuses.get(id);
              const member = cluster.members.find((m) => m.environmentId === id);
              if (!env || !member) return null;
              return (
                <button
                  key={id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={id === current.id}
                  data-draft-host-option={id}
                  onClick={() => {
                    setOpen(false);
                    rememberProjectHost(cluster.key, id);
                    if (id !== current.id) onPick(member.path);
                  }}
                  className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-[12px] text-content/80 hover:bg-content/10 hover:text-content"
                >
                  <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${s ? toneOf(s, degradedFor(s, Number.POSITIVE_INFINITY) !== null) : "bg-content/25"}`} />
                  <span className="min-w-0 flex-1 truncate">{env.name}</span>
                  <span className="shrink-0 text-[11px] text-content/40">{s ? statusText(s, now) : ""}</span>
                  {id === current.id ? <Check className="size-3.5 shrink-0" strokeWidth={2.25} /> : null}
                </button>
              );
            })}
          </div>
        </Popover>
      ) : null}
    </>
  );
}
