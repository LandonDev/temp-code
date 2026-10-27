import { registry } from "../connection";
import type { HarnessId } from "../session";
import { HARNESSES } from "../session";
import { availabilityFromDoctor, probeDoctor } from "../tcserver/catalog";
import { isLiveHarness } from "./registry";

export type HarnessAvailability = Record<HarnessId, boolean>;

/**
 * The server's doctor answers "is the CLI installed" for every harness it
 * runs; we only ever check for the binary, never for a login, so the hint
 * must not blame one.
 */
const CLI: Record<HarnessId, { name: string; install?: string }> = {
  claude: { name: "Claude Code CLI" },
  codex: { name: "Codex CLI" },
  cursor: { name: "Cursor CLI" },
  grok: {
    name: "Grok Build CLI",
    install: "curl -fsSL https://x.ai/cli/install.sh | bash",
  },
  opencode: { name: "OpenCode CLI" },
  pi: { name: "Pi CLI", install: "npm i -g @earendil-works/pi-coding-agent" },
  omp: { name: "omp CLI", install: "curl -fsSL https://omp.sh/install | sh" },
  fx: { name: "fx CLI", install: "curl -fsSL https://fx.sh/setup.sh | bash" },
};

const NONE: HarnessAvailability = Object.fromEntries(HARNESSES.map((id) => [id, false])) as HarnessAvailability;

/** Per environment (thread K2): the box has its own CLIs. */
type Probe = { availability: HarnessAvailability; inflight: Promise<void> | null; probedAt: number };
const probes = new Map<string, Probe>();
const probeOf = (environmentId: string): Probe => {
  let probe = probes.get(environmentId);
  if (!probe) {
    probe = { availability: NONE, inflight: null, probedAt: 0 };
    probes.set(environmentId, probe);
  }
  return probe;
};
/** The window's own machine, the environment a call names none for. */
const here = (): string => registry.primaryEnvironmentId;
let version = 0;
const listeners = new Set<() => void>();

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeHarnessAvailability(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

export function getHarnessAvailabilitySnapshot(): number {
  return version;
}

export function hasProbedHarnessAvailability(environmentId: string = here()): boolean {
  return probeOf(environmentId).probedAt > 0;
}

export function isHarnessAvailable(id: HarnessId, environmentId: string = here()): boolean {
  return probeOf(environmentId).availability[id];
}

/** The shell command that installs a CLI, when there is one to give. */
export function harnessInstallCommand(id: HarnessId): string | undefined {
  return CLI[id].install;
}

export function harnessUnavailableHint(id: HarnessId): string {
  if (!isLiveHarness(id)) {
    return `${CLI[id].name} moves to the server later this milestone.`;
  }
  const { name, install } = CLI[id];
  const how = install ? ` (\`${install}\`)` : "";
  return `${name} not found${how}. Install it, or restart TempCode if it is already installed.`;
}

/** One `doctor.get` per host per 30 s answers for every harness; `force` refreshes. */
export function probeHarnessAvailability(
  options?: { force?: boolean; environmentId?: string },
): Promise<void> {
  const environmentId = options?.environmentId ?? here();
  const probe = probeOf(environmentId);
  if (probe.inflight) return probe.inflight;
  probe.inflight = probeDoctor(environmentId, options)
    .then((doctor) => {
      const found = availabilityFromDoctor(doctor);
      const next = { ...probe.availability };
      for (const id of HARNESSES) next[id] = isLiveHarness(id) && found[id];
      probe.availability = next;
      emit();
    })
    .catch(() => undefined)
    .finally(() => {
      probe.probedAt = Date.now();
      probe.inflight = null;
    });
  return probe.inflight;
}

/** An environment was forgotten: its probe goes with it. */
export function dropHarnessAvailability(environmentId: string): void {
  if (probes.delete(environmentId)) emit();
}
