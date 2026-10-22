import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AdmissionState } from "@server/shared/contract-admission";
import { ErrorLine, errorText } from "../chrome/ConfirmDialog";
import { registry, useEnvironmentStatus, useEnvironments } from "../lib/connection";
import { Heading, Input, Row } from "./settingsBits";
import { MatrixSpinner } from "./threads/bits";

/**
 * Settings → Remote access → Running threads (src/main/server/admission.ts):
 * per host, how many harnesses run of its cap and how many threads wait,
 * the cap (pinned here, or the default the host sizes from memory) and the
 * memory it is sized from. A host that does not answer admission.get (an
 * older build) or is not connected has no row.
 */

const POLL_MS = 5000;

export function AdmissionSettings(): ReactNode {
  const environments = useEnvironments();
  const [answered, setAnswered] = useState<Record<string, boolean>>({});
  const onAnswer = useCallback((id: string, ok: boolean) => setAnswered((a) => (a[id] === ok ? a : { ...a, [id]: ok })), []);
  const shown = environments.some((e) => answered[e.id] !== false);
  return (
    <>
      {shown ? <Heading title="Running threads" /> : null}
      {environments.map((env) => (
        <HostAdmission key={env.id} environmentId={env.id} name={env.name} onAnswer={onAnswer} />
      ))}
    </>
  );
}

/** 81920 → "80 GiB", 9216 → "9 GiB", 2560 → "2.5 GiB". */
export function gib(mb: number): string {
  const n = mb / 1024;
  return `${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10} GiB`;
}

export function runningLine(s: AdmissionState): string {
  return `Running ${s.running} of ${s.cap}${s.queued > 0 ? ` · ${s.queued} queued` : ""}`;
}

export function memoryLine(s: AdmissionState): string {
  return `${gib(s.memory.budgetMB)} budget · ${s.memory.perProcessMB} MB per thread · ${gib(s.memory.freeMB)} free`;
}

function HostAdmission({
  environmentId,
  name,
  onAnswer,
}: {
  environmentId: string;
  name: string;
  onAnswer: (environmentId: string, ok: boolean) => void;
}): ReactNode {
  const status = useEnvironmentStatus(environmentId);
  const connected = status.transport === "open";
  const admin = status.lastHello?.caps.includes("admin") ?? false;
  const [state, setState] = useState<AdmissionState | null | "none">(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connected) return;
    let live = true;
    const load = async (): Promise<void> => {
      try {
        const next = await registry.link(environmentId)!.request<AdmissionState>("admission.get", {});
        if (live) setState(next);
      } catch {
        // An older host without admission control: no row.
        if (live) setState("none");
      }
    };
    void load();
    const t = window.setInterval(() => void load(), POLL_MS);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [connected, environmentId]);
  useEffect(() => onAnswer(environmentId, connected && state !== "none"), [connected, environmentId, onAnswer, state]);

  const pin = async (cap: number | null): Promise<void> => {
    setError(null);
    try {
      setState(await registry.link(environmentId)!.request<AdmissionState>("admission.set", { cap }));
    } catch (err) {
      setError(errorText(err));
    }
  };

  if (!connected || state === "none") return null;
  if (!state) {
    return (
      <Row label={name}>
        <MatrixSpinner cell={1.5} />
      </Row>
    );
  }
  return (
    <>
      <Row
        label={name}
        description={
          <>
            <span className="block text-content/70">{runningLine(state)}</span>
            <span className="block">{memoryLine(state)}</span>
          </>
        }
      >
        {state.pinned !== null && admin ? (
          <button
            type="button"
            onClick={() => void pin(null)}
            className="text-[12px] text-content/50 underline decoration-content/20 underline-offset-2 hover:text-content"
          >
            Use default
          </button>
        ) : null}
        <CapField key={`${state.pinned}`} pinned={state.pinned} fallback={state.default} disabled={!admin} onCommit={(cap) => void pin(cap)} />
      </Row>
      <ErrorLine error={error} />
    </>
  );
}

function CapField({
  pinned,
  fallback,
  disabled,
  onCommit,
}: {
  pinned: number | null;
  fallback: number;
  disabled: boolean;
  onCommit: (cap: number) => void;
}): ReactNode {
  const [text, setText] = useState(pinned === null ? "" : String(pinned));
  const commit = (): void => {
    const cap = Number(text.trim());
    if (text.trim() && Number.isInteger(cap) && cap >= 1 && cap <= 10_000 && cap !== pinned) onCommit(cap);
    else setText(pinned === null ? "" : String(pinned));
  };
  return (
    <Input
      aria-label="Running cap"
      inputMode="numeric"
      value={text}
      placeholder={String(fallback)}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className="w-20 text-right"
    />
  );
}
