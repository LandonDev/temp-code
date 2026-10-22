import { useRef, useState } from "react";
import { Check, ChevronDown } from "./icons";
import { Popover } from "./Popover";
import { DeployDriftMark } from "./DeployDrift";
import {
  degradedFor,
  useEnvironmentDegraded,
  useEnvironmentStatuses,
  useEnvironments,
  useSlowEnvironments,
  type EnvironmentStatus,
} from "../lib/connection";
import { requestEnvironmentSwitch } from "../lib/environmentSwitch";
import { MOD } from "../lib/platform";
import { shell } from "../stores/shell";
import { useCurrentEnvironmentId } from "../stores/environment";
import { statusText } from "../surfaces/EnvironmentsSettings";
import { settingsChunk } from "../surfaces/chunks";

/**
 * Which machine the window is on, and a menu to move to another: the
 * environment of the thread or workspace on screen, with its connection
 * dot. Shown only when there is somewhere else to go.
 */

export function toneOf(status: EnvironmentStatus, degraded: boolean, slow = false): string {
  if (status.transport === "open") return slow ? "bg-warning" : status.fresh ? "bg-success" : "bg-success/50";
  if (!degraded) return "bg-success";
  switch (status.transport) {
    case "connecting":
    case "reconnecting":
      return "bg-warning motion-safe:animate-pulse";
    case "unauthorized":
      return "bg-danger";
    default:
      return "bg-content/25";
  }
}

export function EnvironmentSwitcher({ variant = "header" }: { variant?: "header" | "rail" }) {
  const environments = useEnvironments();
  const statuses = useEnvironmentStatuses();
  const slow = useSlowEnvironments();
  const currentId = useCurrentEnvironmentId();
  const degraded = useEnvironmentDegraded(currentId);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement | null>(null);
  if (environments.length < 2) return null;
  const current = environments.find((e) => e.id === currentId) ?? environments[0];
  const status = statuses.get(current.id);
  const now = Date.now();
  const rail = variant === "rail";
  return (
    <>
      <button
        ref={button}
        type="button"
        data-environment-switcher
        data-tauri-drag-region="false"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Environment: ${current.name}`}
        title={status ? `${current.name}: ${statusText(status, now, slow.has(current.id))} (${MOD}⌥] next)` : current.name}
        onClick={() => setOpen((v) => !v)}
        className={
          rail
            ? `flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] ${open ? "bg-content/10 text-content" : "text-content/70 hover:bg-content/5 hover:text-content"}`
            : `flex h-6 max-w-40 items-center gap-1.5 rounded-md px-1.5 text-[11px] ${open ? "bg-content/10 text-content" : "text-content/50 hover:bg-content/5 hover:text-content"}`
        }
      >
        <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${status ? toneOf(status, degraded !== null, slow.has(current.id)) : "bg-content/25"}`} />
        <span className="min-w-0 flex-1 truncate">{current.name}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" strokeWidth={2} />
      </button>
      {open ? (
        <Popover anchor={button} side="bottom" align="start" width={240} onDismiss={() => setOpen(false)} className="flex flex-col p-1" autoFocus>
          <div role="menu" aria-label="Environments" className="flex flex-col">
            {environments.map((env, i) => {
              const s = statuses.get(env.id);
              const row = s ? degradedFor(s, Number.POSITIVE_INFINITY) : null;
              return (
                <button
                  key={env.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={env.id === current.id}
                  data-environment-option={env.id}
                  onClick={() => {
                    setOpen(false);
                    requestEnvironmentSwitch(env.id);
                  }}
                  className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-[12px] text-content/80 hover:bg-content/10 hover:text-content"
                >
                  <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${s ? toneOf(s, row !== null, slow.has(env.id)) : "bg-content/25"}`} />
                  <span className="min-w-0 flex-1 truncate">{env.name}</span>
                  <span className="shrink-0 text-[11px] text-content/40">{s ? statusText(s, now, slow.has(env.id)) : ""}</span>
                  <DeployDriftMark environmentId={env.id} />
                  {env.id === current.id ? (
                    <Check className="size-3.5 shrink-0" strokeWidth={2.25} />
                  ) : i < 9 ? (
                    <span aria-hidden className="w-3.5 shrink-0 text-center text-[11px] text-content/30">
                      {i + 1}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <div className="mt-1 border-t border-content/10 pt-1">
            <button
              type="button"
              role="menuitem"
              {...settingsChunk.intent}
              onClick={() => {
                setOpen(false);
                shell.openSettings("environments");
              }}
              className="flex h-8 w-full items-center rounded-md px-2 text-left text-[12px] text-content/60 hover:bg-content/10 hover:text-content"
            >
              Manage environments…
            </button>
          </div>
        </Popover>
      ) : null}
    </>
  );
}
