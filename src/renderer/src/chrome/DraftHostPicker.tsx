import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "./icons";
import { HostGlyph } from "./HostGlyph";
import { Popover } from "./Popover";
import { useEnvironmentStatuses, useEnvironments } from "../lib/connection/status";
import { copiesOf, ensureLinkedArgs, ensureLinkedOn, probeOf, rememberLinkHost, type CopyProbe } from "../lib/projectHostChoice";
import { sessionStore, useSession, useSessionMeta } from "../lib/tcserver/store";
import type { ProjectMeta } from "../lib/tcserver/types";
import { useWorkspaceCatalog } from "../lib/tcserver/workspaces";
import { Spinner } from "../surfaces/threads/spinners";

/**
 * Where an unsent draft of a linked project starts (CLAUDE.md "One project
 * across hosts"): the composer's host button, the host's glyph and name,
 * and a menu of every connected host. A host with a copy takes the draft at
 * once; one without asks `project.ensureLinked` first (a dry run when the
 * menu opens, so a host with no checkout is disabled with its note) and the
 * copy is made on pick. Picking retargets the draft and is remembered for
 * the link (lib/projectHostChoice.ts). A sent thread moves through the
 * header's host chip instead.
 */
export function DraftHostPicker({ sessionId }: { sessionId: string }) {
  const session = useSession(sessionId);
  const meta = useSessionMeta(sessionId);
  const { projects, workspaces } = useWorkspaceCatalog();
  const environments = useEnvironments();
  const statuses = useEnvironmentStatuses();
  const [open, setOpen] = useState(false);
  const [probes, setProbes] = useState<ReadonlyMap<string, CopyProbe>>(new Map());
  const [making, setMaking] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);

  const project = session?.projectId ? projects.find((p) => p.id === session.projectId && p.environmentId === session.environmentId) : undefined;
  const copies = copiesOf(projects, project?.linkId);
  const args = project ? ensureLinkedArgs(project, workspaces.find((w) => w.id === project.workspaceId && w.environmentId === project.environmentId)) : null;
  const hosts = environments.filter((e) => e.id === session?.environmentId || statuses.get(e.id)?.transport === "open");
  const missing = hosts.filter((h) => !copies.some((c) => c.environmentId === h.id)).map((h) => h.id);
  const missingKey = missing.join(",");

  // Each host without a copy is asked once per opening whether it can take one.
  useEffect(() => {
    if (!open || !args || missing.length === 0) return;
    let live = true;
    setProbes(new Map(missing.map((id) => [id, { state: "checking" } as const])));
    for (const id of missing) {
      ensureLinkedOn(id, args, true).then(
        (result) => live && setProbes((prev) => new Map(prev).set(id, probeOf(result))),
        (err: unknown) => live && setProbes((prev) => new Map(prev).set(id, { state: "none", note: errorLine(err) })),
      );
    }
    return () => {
      live = false;
    };
    // `args` and `missing` are rebuilt every render; the key and the open flag are what change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, missingKey, args?.projectLinkId]);

  if (!session || meta || session.blocks.length > 0 || !project?.linkId || hosts.length < 2) return null;
  const current = environments.find((e) => e.id === session.environmentId);
  if (!current) return null;

  const pick = async (environmentId: string) => {
    if (environmentId === current.id) {
      setOpen(false);
      return;
    }
    const copy = copies.find((c) => c.environmentId === environmentId);
    if (copy) {
      retargetDraft(sessionId, copy);
      rememberLinkHost(project.linkId!, environmentId);
      setOpen(false);
      return;
    }
    if (!args) return;
    setMaking(environmentId);
    try {
      const result = await ensureLinkedOn(environmentId, args);
      if (!result.project) {
        setProbes((prev) => new Map(prev).set(environmentId, probeOf(result)));
        return;
      }
      retargetDraft(sessionId, result.project);
      rememberLinkHost(project.linkId!, environmentId);
      setOpen(false);
    } catch (err) {
      setProbes((prev) => new Map(prev).set(environmentId, { state: "none", note: errorLine(err) }));
    } finally {
      setMaking(null);
    }
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        data-draft-host-picker={current.id}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Start on ${current.name}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        className={`flex min-w-0 shrink-0 items-center gap-1.5 text-[12px] ${open ? "text-content" : "text-content/50 hover:text-content"}`}
      >
        <HostGlyph environmentId={current.id} />
        <span className="max-w-32 truncate">{current.name}</span>
        <ChevronDown className={`size-3 shrink-0 text-content/50 ${open ? "rotate-180" : ""}`} strokeWidth={1.75} />
      </button>
      {open ? (
        <Popover anchor={button} side="top" align="start" width={260} onDismiss={() => setOpen(false)} className="flex flex-col p-1" autoFocus>
          <div role="menu" aria-label="Start this thread on" className="flex flex-col">
            {hosts.map((env) => {
              const has = copies.some((c) => c.environmentId === env.id);
              const probe = has ? undefined : (probes.get(env.id) ?? (args ? { state: "checking" as const } : { state: "none" as const, note: "Not linked yet" }));
              const disabled = making !== null || (!has && probe?.state !== "ready");
              const note = probe?.state === "none" ? probe.note : !has && probe?.state === "ready" ? "New copy" : null;
              return (
                <button
                  key={env.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={env.id === current.id}
                  aria-disabled={disabled || undefined}
                  data-draft-host-option={env.id}
                  disabled={disabled}
                  title={note ?? undefined}
                  onClick={() => void pick(env.id)}
                  className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-[12px] text-content/80 enabled:hover:bg-content/10 enabled:hover:text-content disabled:cursor-default"
                >
                  <HostGlyph environmentId={env.id} className={probe?.state === "none" ? "opacity-50" : ""} />
                  <span className={`min-w-0 flex-1 truncate ${probe?.state === "none" ? "text-content/40" : ""}`}>{env.name}</span>
                  {making === env.id || probe?.state === "checking" ? (
                    <Spinner />
                  ) : note ? (
                    <span className="max-w-32 shrink-0 truncate text-[11px] text-content/40" data-draft-host-note>
                      {note}
                    </span>
                  ) : null}
                  {env.id === current.id ? <Check className="size-3.5 shrink-0" strokeWidth={2.25} /> : null}
                </button>
              );
            })}
          </div>
        </Popover>
      ) : null}
    </>
  );
}

/** Move an unsent draft onto another host's copy of its project. */
export function retargetDraft(sessionId: string, copy: Pick<ProjectMeta, "id" | "environmentId" | "workspaceId" | "cwd">): void {
  sessionStore.mutate((prev) =>
    prev.map((s) =>
      s.id === sessionId
        ? {
            ...s,
            environmentId: copy.environmentId,
            projectId: copy.id,
            workspaceId: copy.workspaceId,
            cwd: copy.cwd,
            branch: undefined,
            worktreeCwd: undefined,
          }
        : s,
    ),
  );
}

function errorLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/^\w+: /, "");
}
