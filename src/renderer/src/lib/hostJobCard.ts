import type { HostJob, HostJobStatus } from "@server/shared/contract-host";

/**
 * The log card's one derived state (Settings → Remote access → Deploy and
 * publish), pure so the states are testable: what the header says, which
 * lines show (the last TAIL_LINES), whether Stop is offered, and the
 * closing line once the job is done. The deploy job cannot be stopped once
 * the trigger has it and the card says so; the box restarting mid-deploy
 * drops the link, and the card says that too until the log goes on.
 */

export const TAIL_LINES = 40;

export type HostJobCard = {
  /** Idle: nothing to show. */
  visible: boolean;
  phase: HostJobStatus["phase"];
  title: string;
  /** The quiet line beside the title, or null. */
  note: string | null;
  lines: string[];
  stoppable: boolean;
  /** The closing line once done, and whether it is a failure. */
  ending: { text: string; failed: boolean } | null;
};

export type HostJobCardInput = {
  job: HostJob;
  status: HostJobStatus;
  text: string;
  /** The host the job runs on, as the row names it. */
  hostName: string;
  /** The socket to that host is open right now. */
  linkUp: boolean;
  /** The version the host reports after the deploy (its new build), when known. */
  deployedVersion?: string | null;
};

export function tailLines(text: string, count = TAIL_LINES): string[] {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.length > count ? lines.slice(lines.length - count) : lines;
}

const versionText = (v: string | null | undefined): string | null => (v ? (v.startsWith("v") ? v : `v${v}`) : null);

export function hostJobCard(input: HostJobCardInput): HostJobCard {
  const { job, status, text, hostName, linkUp } = input;
  const lines = tailLines(text);
  const target = status.target;
  if (status.phase === "idle") {
    return { visible: false, phase: "idle", title: "", note: null, lines, stoppable: false, ending: null };
  }
  if (job === "deploy") {
    const what = target ?? "master";
    if (status.phase === "pending") {
      return { visible: true, phase: "pending", title: `Deploying ${what} to ${hostName}`, note: "Waiting for the trigger on the box", lines, stoppable: false, ending: null };
    }
    if (status.phase === "running") {
      const note = linkUp ? "Cannot be stopped mid-way; the box rolls back on failure" : "The box is restarting; the log continues when it is back";
      return { visible: true, phase: "running", title: `Deploying ${what} to ${hostName}`, note, lines, stoppable: false, ending: null };
    }
    if (status.exit === 0) {
      const version = versionText(input.deployedVersion) ?? what;
      return { visible: true, phase: "done", title: `Deployed ${what} to ${hostName}`, note: null, lines, stoppable: false, ending: { text: `Deployed ${version}, the service is back`, failed: false } };
    }
    const text = status.exit === null ? "Deploy did not start" : `Deploy failed (exit ${status.exit})`;
    return { visible: true, phase: "done", title: `Deploy of ${what} to ${hostName}`, note: null, lines, stoppable: false, ending: { text, failed: true } };
  }
  const version = versionText(target) ?? "the Mac release";
  if (status.phase === "pending" || status.phase === "running") {
    return { visible: true, phase: status.phase, title: `Publishing ${version}`, note: "Signing, notarizing and uploading from this Mac", lines, stoppable: status.stoppable, ending: null };
  }
  if (status.exit === 0) {
    return { visible: true, phase: "done", title: `Published ${version}`, note: null, lines, stoppable: false, ending: { text: `Published ${version}; the installed app offers it on its next check`, failed: false } };
  }
  const stopped = status.exit === 143 || status.exit === 137;
  return {
    visible: true,
    phase: "done",
    title: stopped ? `Publish of ${version} stopped` : `Publish of ${version} failed`,
    note: null,
    lines,
    stoppable: false,
    ending: { text: stopped ? "Stopped; nothing was published" : `Publish failed (exit ${status.exit ?? "?"})`, failed: true },
  };
}

const releaseN = (version: string | null | undefined): number | null => {
  const m = version?.match(/^v?1\.0\.(\d+)$/);
  return m ? Number(m[1]) : null;
};

/** The deploy confirm's body: the versions, and how many releases lie between them. */
export function deployConfirmText(hostName: string, deployed: string | null, master: string | null): string {
  const from = versionText(deployed);
  const to = versionText(master);
  const a = releaseN(deployed);
  const b = releaseN(master);
  if (from && to && a !== null && b !== null) {
    const n = b - a;
    if (n > 0) return `${from} → ${to}, ${n} ${n === 1 ? "release" : "releases"}. ${hostName} rebuilds master, trials it and restarts; it rolls back if the trial fails.`;
    if (n === 0) return `${hostName} already runs ${to}. Deploying rebuilds master from GitHub and restarts the service anyway.`;
    return `${from} → ${to}: master is behind what ${hostName} runs. Deploying rebuilds master and restarts the service.`;
  }
  if (from) return `${hostName} runs ${from}. Deploying rebuilds master from GitHub, trials it and restarts the service.`;
  return `${hostName} rebuilds master from GitHub, trials it and restarts the service; it rolls back if the trial fails.`;
}

/** The line under a box's row. */
export function deployRowLine(opts: { installed: boolean; version: string | null; masterVersion: string | null; connected: boolean; phase: HostJobStatus["phase"] }): string {
  if (!opts.connected) return "Not connected right now.";
  if (!opts.installed) return "Deploy from the app is not installed on this host.";
  const runs = versionText(opts.version);
  const a = releaseN(opts.version);
  const b = releaseN(opts.masterVersion);
  const behind = a !== null && b !== null ? b - a : null;
  if (opts.phase === "pending" || opts.phase === "running") return `Runs ${runs ?? "an unknown version"} · deploying`;
  if (behind === null) return `Runs ${runs ?? "an unknown version"}.`;
  if (behind <= 0) return `Runs ${runs} · up to date with master`;
  return `Runs ${runs} · ${behind} ${behind === 1 ? "release" : "releases"} behind master`;
}
