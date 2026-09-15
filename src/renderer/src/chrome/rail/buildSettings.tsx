import { useEffect, useRef, useState } from "react";
import type { BuildConfig } from "@server/shared/build";
import { client } from "../../lib/tcserver/client";
import { OPEN_SETTINGS_EVENT } from "../../lib/monaco/debugTab";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { Input, Row } from "../../surfaces/settingsBits";
import { MatrixSpinner } from "../../surfaces/threads/bits";

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
      description: "Globs for the files it produces, comma-separated; ! excludes.",
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
            className={compact ? "w-full font-mono" : "w-56 font-mono"}
          />
        );
        return compact ? (
          <label key={f.key} className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold tracking-[0.08em] text-content/50 uppercase">{f.label}</span>
            {input}
          </label>
        ) : (
          <Row key={f.key} label={f.label} description={f.description}>
            {input}
          </Row>
        );
      })}
    </>
  );
}

/** Self-loading editor for the workspace settings page; saves as you type. */
export function BuildEditor({ workspaceId }: { workspaceId: string }) {
  const path = useWorkspaces().find((w) => w.id === workspaceId)?.path;
  const [config, setConfig] = useState<BuildConfig | undefined>(undefined);
  const [detected, setDetected] = useState<BuildConfig | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let live = true;
    void client
      .request<BuildConfig | null>("build.get", { workspaceId })
      .then((c) => live && setConfig(c ?? BUILD_EMPTY))
      .catch(() => live && setConfig(BUILD_EMPTY));
    if (path) {
      void client
        .request<BuildConfig | null>("build.detect", { path })
        .then((d) => live && setDetected(d))
        .catch(() => {});
    }
    return () => {
      live = false;
      window.clearTimeout(timer.current);
    };
  }, [workspaceId, path]);

  const push = (next: BuildConfig): void => {
    setConfig(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void client.request("build.set", { workspaceId, config: buildOrNull(next) });
    }, 500);
  };

  if (config === undefined) {
    return (
      <div className="flex h-16 items-center justify-center">
        <MatrixSpinner />
      </div>
    );
  }
  return <BuildFields value={config} onChange={push} detected={detected} />;
}

// ── deep link from the Build rail tab ─────────────────────────────────

let requestedScope: string | undefined;

/** Open Settings on the Build page with this workspace selected. */
export function openBuildSettings(workspaceId: string): void {
  requestedScope = workspaceId;
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: "build" }));
}

/** The scope a deep link asked for, consumed once. */
export function takeRequestedBuildScope(): string | undefined {
  const scope = requestedScope;
  requestedScope = undefined;
  return scope;
}
