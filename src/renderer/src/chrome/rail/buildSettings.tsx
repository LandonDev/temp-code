import { useEffect, useRef, useState } from "react";
import type { BuildConfig } from "@server/shared/build";
import { registry } from "../../lib/connection";
import { OPEN_SETTINGS_EVENT } from "../../lib/monaco/debugTab";
import { workspaceSettingsSection } from "../../lib/settings";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { PageRow } from "../../components/page";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";

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
            className={compact ? "font-mono text-[12px]" : "w-64 font-mono text-[12px]"}
          />
        );
        return compact ? (
          <label key={f.key} className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-muted-foreground">{f.label}</span>
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

/** Self-loading editor for the workspace settings page; saves as you type. */
export function BuildEditor({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaces().find((w) => w.id === workspaceId);
  const path = workspace?.path;
  const environmentId = workspace?.environmentId;
  const [config, setConfig] = useState<BuildConfig | undefined>(undefined);
  const [detected, setDetected] = useState<BuildConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!environmentId) return;
    let live = true;
    void registry.linkOf(environmentId)
      .request<BuildConfig | null>("build.get", { workspaceId })
      .then((c) => live && setConfig(c ?? BUILD_EMPTY))
      .catch(() => live && setConfig(BUILD_EMPTY));
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
    setConfig(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setError(null);
      registry
        .linkOf(environmentId)
        .request("build.set", { workspaceId, config: buildOrNull(next) })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }, 500);
  };

  if (config === undefined) {
    return (
      <div data-testid="build-skeleton" aria-hidden className="flex flex-col">
        {[0, 1].map((i) => (
          <div key={i} className="flex items-center gap-3 py-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3 w-56" />
            </div>
            <Skeleton className="h-8 w-64" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <>
      <BuildFields value={config} onChange={push} detected={detected} />
      {error ? <p className="pt-2 text-[12px] text-destructive">{error}</p> : null}
    </>
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
