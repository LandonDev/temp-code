import { useEffect, useRef, useState } from "react";
import type { BuildConfig } from "@server/shared/build";
import { registry } from "../../lib/connection";
import { useHostRead } from "../../lib/connection/hostRead";
import { Button } from "../../components/ui/button";
import { OPEN_SETTINGS_EVENT } from "../../lib/monaco/debugTab";
import { workspaceSettingsSection } from "../../lib/settings";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { PageError, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { Input } from "../../components/ui/input";

/**
 * The workspace's build command (Build rail tab, and what the completed-turn
 * build step names). Placeholders show what the app detects from the
 * checkout; leaving both fields empty keeps that detection.
 */

export const BUILD_EMPTY: BuildConfig = { command: "", outputs: "" };

/** An override with no command means "inherit" — store nothing. */
export const buildOrNull = (c: BuildConfig | null): BuildConfig | null =>
  c && c.command.trim() ? { command: c.command.trim(), outputs: c.outputs.trim() } : null;

export function BuildFields({
  value,
  onChange,
  detected,
  compact,
}: {
  value: BuildConfig;
  onChange: (next: BuildConfig) => void;
  detected: BuildConfig | null;
  /** narrow host (the project dialog): no descriptions, stacked label + input */
  compact?: boolean;
}) {
  const fields = [
    {
      key: "command" as const,
      label: "Command",
      description: "Runs in the project checkout through your login shell.",
      placeholder: detected?.command ?? "e.g. mvn -B package",
    },
    {
      key: "outputs" as const,
      label: "Outputs",
      description: "Globs of the files it makes, comma-separated. ! excludes.",
      placeholder: detected?.outputs || "e.g. target/*.jar",
    },
  ];
  return (
    <>
      {fields.map((f) => {
        const input = (
          <Input
            value={value[f.key]}
            onChange={(e) => onChange({ ...value, [f.key]: e.target.value })}
            placeholder={f.placeholder}
            spellCheck={false}
            aria-label={`Build ${f.label.toLowerCase()}`}
            className={compact ? "font-mono text-xs" : "w-64 font-mono text-xs"}
          />
        );
        return compact ? (
          <label key={f.key} className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{f.label}</span>
            {input}
          </label>
        ) : (
          <PageRow key={f.key} title={f.label} description={f.description}>
            {input}
          </PageRow>
        );
      })}
    </>
  );
}

/** The workspace page's Build section, self-loading; saves as you type.
 *  Its fields stay away until `build.get` answers, so nothing typed into an
 *  empty stand-in can save over the real config; no answer is the section's
 *  error and Retry. */
export function BuildEditor({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaces().find((w) => w.id === workspaceId);
  const path = workspace?.path;
  const environmentId = workspace?.environmentId;
  const link = environmentId ? registry.linkOf(environmentId) : null;
  const read = useHostRead(
    link,
    async () => (await link!.request<BuildConfig | null>("build.get", { workspaceId })) ?? BUILD_EMPTY,
    workspaceId,
  );
  const config = read.value;
  const [detected, setDetected] = useState<BuildConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!environmentId) return;
    let live = true;
    if (path) {
      void registry.linkOf(environmentId)
        .request<BuildConfig | null>("build.detect", { path })
        .then((d) => live && setDetected(d))
        .catch(() => {});
    }
    return () => {
      live = false;
      window.clearTimeout(timer.current);
    };
  }, [environmentId, workspaceId, path]);

  const push = (next: BuildConfig): void => {
    if (!environmentId) return;
    read.set(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setError(null);
      registry
        .linkOf(environmentId)
        .request("build.set", { workspaceId, config: buildOrNull(next) })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }, 500);
  };

  const failed = config === undefined && read.error !== null;
  return (
    <PageSection
      title="Build"
      action={
        failed ? (
          <Button variant="ghost" size="sm" onClick={read.retry}>
            Retry
          </Button>
        ) : null
      }
    >
      {config ? (
        <>
          <BuildFields value={config} onChange={push} detected={detected} />
          {error ? <PageError>{error}</PageError> : null}
        </>
      ) : failed ? (
        <PageError>{read.error}</PageError>
      ) : (
        <div data-testid="build-skeleton">
          <PageRowsSkeleton rows={2} description control="field" />
        </div>
      )}
    </PageSection>
  );
}

// ── deep link from the Build rail tab ─────────────────────────────────

let requestedFocus = false;

/** Open Settings on this workspace's page with its Build section in view. */
export function openBuildSettings(workspaceId: string): void {
  requestedFocus = true;
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: workspaceSettingsSection(workspaceId) }));
}

/** Whether a deep link asked for the Build section, consumed once. */
export function takeRequestedBuildFocus(): boolean {
  const focus = requestedFocus;
  requestedFocus = false;
  return focus;
}
