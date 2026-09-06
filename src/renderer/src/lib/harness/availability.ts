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

let availability: HarnessAvailability = Object.fromEntries(
  HARNESSES.map((id) => [id, false]),
) as HarnessAvailability;
let version = 0;
let inflight: Promise<void> | null = null;
let probedAt = 0;
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

export function hasProbedHarnessAvailability(): boolean {
  return probedAt > 0;
}

export function isHarnessAvailable(id: HarnessId): boolean {
  return availability[id];
}

export function harnessUnavailableHint(id: HarnessId): string {
  if (!isLiveHarness(id)) {
    return `${CLI[id].name} moves to the server later this milestone.`;
  }
  const { name, install } = CLI[id];
  const how = install ? ` (\`${install}\`)` : "";
  return `${name} not found${how}. Install it, or restart MonoCode if it is already installed.`;
}

/** One `doctor.get` per 30 s answers for every harness; `force` refreshes. */
export function probeHarnessAvailability(
  options?: { force?: boolean },
): Promise<void> {
  if (inflight) return inflight;
  inflight = probeDoctor(options)
    .then((doctor) => {
      const found = availabilityFromDoctor(doctor);
      const next = { ...availability };
      for (const id of HARNESSES) next[id] = isLiveHarness(id) && found[id];
      availability = next;
      emit();
    })
    .catch(() => undefined)
    .finally(() => {
      probedAt = Date.now();
      inflight = null;
    });
  return inflight;
}
