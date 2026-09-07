import type { ConductOverride, ThreadRules } from "@server/shared/rules";
import { useRulesScope, type OrchestrationRules } from "../lib/tcserver/rules";
import { Segmented, Select, Toggle } from "../surfaces/settingsBits";
import { RotateCcw } from "./icons";

/**
 * Per-run orchestration tune, shared by the new-thread chooser and the
 * plan's Start popover. The workspace or global rules from Settings stay
 * the default: every row shows the inherited value quietly; touching a
 * control records an override for this one thread, with a reset so
 * inherit is one tap away. Picking the default again clears the override,
 * so the tune never stores what Settings already says.
 */

type Conduct = OrchestrationRules["conduct"];

const DELEGATION: { value: Conduct["delegation"]; label: string }[] = [
  { value: "strict", label: "Strict" },
  { value: "balanced", label: "Balanced" },
  { value: "free", label: "Free" },
];

const SWITCHES: { key: keyof Conduct; label: string }[] = [
  { key: "selfEdit", label: "Edit files itself" },
  { key: "selfShell", label: "Run shell itself" },
  { key: "verifyResults", label: "Verify agent reports" },
  { key: "escalate", label: "Escalate on weak output" },
  { key: "useWorktrees", label: "Worktree isolation" },
];

const PARALLEL_STEPS = [1, 2, 4, 8, 16, 0];
const TOTAL_STEPS = [10, 25, 50, 100, 0];

/** Record `v` for `k`, or drop the override when it matches the base. */
export function setConduct<K extends keyof Conduct>(
  prev: ThreadRules,
  base: Conduct,
  k: K,
  v: Conduct[K],
): ThreadRules {
  const next: ConductOverride = { ...prev.conduct };
  if (v === base[k]) delete next[k];
  else (next as Record<string, unknown>)[k] = v;
  return { ...prev, conduct: Object.keys(next).length ? next : undefined };
}

/** How many settings this tune overrides; the chooser rows caption it. */
export function tuneSummary(t: ThreadRules): string | null {
  const n = Object.keys(t.conduct ?? {}).length;
  const parts = [
    n > 0 ? `${n} override${n > 1 ? "s" : ""}` : null,
    t.instructions?.trim() ? "instructions" : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" + ") : null;
}

/** True when the tune says anything the thread should carry. */
export function tuneIsSet(t: ThreadRules): boolean {
  return !!t.conduct || !!t.instructions?.trim();
}

export function OrchestrationTune({
  workspaceId,
  value,
  onChange,
}: {
  workspaceId: string | null;
  value: ThreadRules;
  /** A state setter: updates are functional so rapid changes never clobber. */
  onChange: React.Dispatch<React.SetStateAction<ThreadRules>>;
}) {
  const { scope } = useRulesScope(workspaceId);
  const base = scope?.rules.conduct ?? null;
  const over = value.conduct ?? {};
  const effective = <K extends keyof Conduct>(k: K): Conduct[K] | undefined =>
    (over[k] as Conduct[K] | undefined) ?? base?.[k];
  const set = <K extends keyof Conduct>(k: K, v: Conduct[K]) => {
    if (!base) return;
    onChange((prev) => setConduct(prev, base, k, v));
  };

  const Row = ({ k, label, children }: { k: keyof Conduct; label: string; children: React.ReactNode }) => {
    const overridden = k in over;
    return (
      <div className="group/row flex h-8 items-center gap-2">
        <span className={`min-w-0 flex-1 truncate text-[12.5px] ${overridden ? "text-content" : "text-content/55"}`}>
          {label}
        </span>
        {overridden && base ? (
          <button
            type="button"
            onClick={() => set(k, base[k])}
            title="Back to default"
            aria-label={`Reset ${label} to default`}
            className="flex size-5 items-center justify-center rounded text-content/50 opacity-0 transition group-hover/row:opacity-100 hover:text-content active:scale-95"
          >
            <RotateCcw className="size-3" />
          </button>
        ) : null}
        {children}
      </div>
    );
  };

  return (
    <div className="flex flex-col">
      <textarea
        value={value.instructions ?? ""}
        onChange={(e) => {
          const text = e.target.value;
          onChange((prev) => ({ ...prev, instructions: text || undefined }));
        }}
        placeholder="Custom instructions for this run…"
        rows={2}
        className="max-h-32 min-h-[52px] w-full resize-none rounded-lg border border-content/10 bg-content/5 px-2.5 py-2 text-[12.5px] leading-snug text-content outline-none placeholder:text-content/40 focus:border-content/20"
      />

      <p className="mt-3 mb-1 text-[10px] font-medium tracking-[0.08em] text-content/40 uppercase">
        Rules · defaults from Settings
      </p>

      <Row k="delegation" label="Delegation">
        <Segmented
          label="Delegation"
          value={effective("delegation") ?? "balanced"}
          options={DELEGATION}
          onChange={(v) => set("delegation", v)}
        />
      </Row>

      {SWITCHES.map((s) => (
        <Row key={s.key} k={s.key} label={s.label}>
          <Toggle
            label={s.label}
            on={effective(s.key) === true}
            onChange={(on) => set(s.key, on as Conduct[typeof s.key])}
          />
        </Row>
      ))}

      <Row k="maxParallel" label="Parallel agents">
        <CountSelect
          label="Parallel agents"
          steps={PARALLEL_STEPS}
          value={effective("maxParallel") ?? 0}
          onPick={(n) => set("maxParallel", n)}
        />
      </Row>
      <Row k="maxAgents" label="Total per thread">
        <CountSelect
          label="Total per thread"
          steps={TOTAL_STEPS}
          value={effective("maxAgents") ?? 0}
          onPick={(n) => set("maxAgents", n)}
        />
      </Row>
    </div>
  );
}

function CountSelect({
  label,
  steps,
  value,
  onPick,
}: {
  label: string;
  steps: number[];
  value: number;
  onPick: (n: number) => void;
}) {
  // A stored value outside the ladder (typed in Settings) still shows.
  const options = steps.includes(value) ? steps : [...steps, value].sort((a, b) => a - b);
  return (
    <Select
      label={label}
      value={String(value)}
      onChange={(v) => onPick(Number(v))}
      options={options.map((n) => ({ value: String(n), label: n === 0 ? "Unlimited" : String(n) }))}
    />
  );
}
