import { useCallback, useEffect, useMemo, useState } from "react";
import { EDITOR_IDS, EDITOR_LABELS, type EditorChoice } from "@shared/editor";
import { useProjects } from "../../lib/tcserver/workspaces";
import type { LspStatusRow } from "@shared/domain";
import {
  loadAutoSave,
  loadFormatOnSave,
  loadGhostText,
  saveAutoSave,
  saveFormatOnSave,
  saveGhostText,
  type FormatOnSave,
} from "../../lib/settings";
import { registry } from "../../lib/connection";
import { retryBlockedEnsures } from "../../lib/monaco/lspGate";
import { chooseEditorSetting, useEditorConfig } from "../../lib/editorConfig";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Spinner } from "../../components/ui/spinner";
import { ChoiceSelect } from "../../components/choice-select";
import { PageRow, PageSection } from "../../components/page";
import { SettingSwitch } from "../../components/setting-switch";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Keys, MOD_CAP } from "./keys";

type IdeaEngine = { dist: boolean; accepted: boolean; build: string };

type JavaDoctor = {
  found: boolean;
  path?: string;
  version?: string;
  jdtls: boolean;
  ideaServer?: IdeaEngine;
  error?: string;
};

const LSP_LABEL: Record<LspStatusRow["lang"], string> = {
  java: "jdtls",
  idea: "IntelliJ engine",
  web: "vtsls",
};

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** A server's figures for the row's end: memory and idle time, or its state. */
export function lspFigures(row: LspStatusRow): string[] {
  if (row.state === "running") {
    const figures = [row.memoryBytes != null ? fmtBytes(row.memoryBytes) : "Running"];
    if (row.idleMs > 60_000) figures.push(`idle ${Math.round(row.idleMs / 60_000)}m`);
    return figures;
  }
  if (row.state === "error") return [];
  return [`${row.state[0].toUpperCase()}${row.state.slice(1)}…`];
}

/** Live language-server rows, polled while the page is open. M7a's push
 *  of readiness changes can replace the poll once it lands. */
function LanguageServers() {
  const [rows, setRows] = useState<LspStatusRow[] | null>(null);
  const projects = useProjects();
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      void registry.primary()
        .request<LspStatusRow[]>("lsp.status")
        .then((next) => {
          if (!cancelled) setRows(next);
        })
        .catch(() => {
          if (!cancelled) setRows([]);
        });
    tick();
    const timer = window.setInterval(tick, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  return (
    <PageSection title="Language servers">
      {rows === null ? (
        <div aria-busy="true" aria-label="Loading">
          {[0, 1].map((i) => (
            <div key={i} className="flex flex-col gap-1.5 py-3">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3 w-40" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="py-3 text-xs text-muted-foreground">None running</p>
      ) : (
        rows.map((row) => {
          const project = projectNames.get(row.projectId) ?? row.projectId;
          return (
            <PageRow
              key={row.serverId}
              title={LSP_LABEL[row.lang]}
              description={project}
              error={row.state === "error" ? (row.error ?? "Failed") : undefined}
            >
              {lspFigures(row).map((figure) => (
                <span key={figure} className="text-xs text-muted-foreground tabular-nums">
                  {figure}
                </span>
              ))}
            </PageRow>
          );
        })
      )}
    </PageSection>
  );
}

/** Which editor "Open in …" and "Open on the Mac" hand a file to. Auto takes
 *  the first of IDEA, VS Code and Xcode installed; a Swift file under ios/
 *  goes to Xcode when Xcode is chosen or IDEA is absent. Absent in web mode
 *  and on a headless host, where no editor runs. */
function OpenFilesIn() {
  const config = useEditorConfig();
  if (!config) return null;
  const found = EDITOR_IDS.filter((id) => config.installed[id]).map((id) => EDITOR_LABELS[id]);
  const description =
    found.length === 0
      ? "No editor found. Install IntelliJ IDEA, VS Code or Xcode."
      : config.editor === "auto" && config.effective
        ? `Found ${listOf(found)}; Auto opens ${EDITOR_LABELS[config.effective]}.`
        : config.editor !== "auto" && !config.installed[config.editor]
          ? `${EDITOR_LABELS[config.editor]} is not installed; ${config.effective ? `${EDITOR_LABELS[config.effective]} opens instead` : "nothing opens"}.`
          : `Found ${listOf(found)}.`;
  const options: { value: EditorChoice; label: string }[] = [
    { value: "auto", label: "Auto" },
    ...EDITOR_IDS.map((id) => ({ value: id, label: EDITOR_LABELS[id] })),
  ];
  return (
    <PageSection title="Open files in">
      <PageRow title="External editor" description={description}>
        <ChoiceSelect label="External editor" value={config.editor} options={options} onChange={(choice) => void chooseEditorSetting(choice)} />
      </PageRow>
    </PageSection>
  );
}

function listOf(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function EditorPage() {
  const [autoSave, setAutoSave] = useState(loadAutoSave);
  const [formatOnSave, setFormatOnSave] = useState<FormatOnSave>(loadFormatOnSave);
  const [ghostText, setGhostText] = useState(loadGhostText);
  const [engine, setEngine] = useState<IdeaEngine | null | undefined>(undefined);
  const [java, setJava] = useState<JavaDoctor | null | undefined>(undefined);
  const [eula, setEula] = useState<{ build: string; text: string } | null>(null);
  const [gateOpen, setGateOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refreshEngine = useCallback(() => {
    void registry.primary()
      .request<{ java?: JavaDoctor }>("doctor.get")
      .then((doctor) => {
        setJava(doctor.java ?? null);
        setEngine(doctor.java?.ideaServer ?? null);
      })
      .catch(() => {
        setJava(null);
        setEngine(null);
      });
  }, []);

  useEffect(() => {
    refreshEngine();
  }, [refreshEngine]);

  const onFormat = (patch: Partial<FormatOnSave>) => {
    const next = { ...formatOnSave, ...patch };
    saveFormatOnSave(next);
    setFormatOnSave(next);
  };

  const openGate = () => {
    setGateOpen(true);
    setNote(null);
    if (eula) return;
    // The first open downloads the dist to read its license.
    void registry.primary()
      .request<{ build: string; text: string }>("idea.eula")
      .then(setEula)
      .catch((error) => setNote(error instanceof Error ? error.message : String(error)));
  };

  const accept = () => {
    void registry.primary()
      .request("idea.acceptEula")
      .then(() => {
        setGateOpen(false);
        retryBlockedEnsures();
        refreshEngine();
      })
      .catch((error) => setNote(error instanceof Error ? error.message : String(error)));
  };

  const [checking, setChecking] = useState(false);
  const checkUpdate = () => {
    setNote(null);
    setChecking(true);
    void registry.primary()
      .request<{ current: string; latest: string; updated: boolean }>("idea.checkUpdate")
      .then((r) => {
        setNote(r.updated ? `Updated to ${r.latest}. Accept the EULA again.` : "Up to date.");
        refreshEngine();
      })
      .catch(() => setNote("Update check failed."))
      .finally(() => setChecking(false));
  };

  const jdkState =
    java === undefined
      ? null
      : !java || !java.found
        ? (java?.error ?? "No JDK found. Install JDK 21 or newer for Java.")
        : java.error
          ? `JDK ${java.version} needs 21 or newer`
          : `JDK ${java.version}, ${java.jdtls ? "jdtls ready" : "jdtls downloads on first use"}`;

  const engineState =
    engine === undefined
      ? null
      : !engine || !engine.dist
        ? "Not downloaded"
        : engine.accepted
          ? `Ready, build ${engine.build}`
          : "Needs the EULA";

  const loading = <Skeleton className="mt-1 h-3 w-40" />;

  return (
    <>
      <PageSection title="Saving">
        <PageRow
          title="Auto save"
          description={
            <>
              Writes 800 ms after the last keystroke;
              <Keys keys={[MOD_CAP, "S"]} />
              writes at once.
            </>
          }
        >
          <SettingSwitch
            label="Auto save"
            on={autoSave}
            onChange={(on) => {
              saveAutoSave(on);
              setAutoSave(on);
            }}
          />
        </PageRow>
        <PageRow title="Java formatting">
          <SettingSwitch label="Java formatting" on={formatOnSave.java} onChange={(on) => onFormat({ java: on })} />
        </PageRow>
        <PageRow title="TypeScript and JavaScript formatting">
          <SettingSwitch
            label="TypeScript and JavaScript formatting"
            on={formatOnSave.web}
            onChange={(on) => onFormat({ web: on })}
          />
        </PageRow>
      </PageSection>

      <PageSection title="Completions">
        <PageRow title="Ghost text" description="Inline completions from Claude on your existing login.">
          <SettingSwitch
            label="Ghost text"
            on={ghostText}
            onChange={(on) => {
              saveGhostText(on);
              setGhostText(on);
            }}
          />
        </PageRow>
      </PageSection>

      <OpenFilesIn />

      <PageSection title="Java">
        <PageRow
          title="JDK"
          description={
            jdkState === null ? (
              loading
            ) : (
              <>
                <span className={java?.error ? "block text-warning" : "block"}>{jdkState}</span>
                {java?.path ? <span className="block truncate font-mono text-[11px]">{java.path}</span> : null}
              </>
            )
          }
        />
        <PageRow title="IntelliJ engine" description={note ?? engineState ?? loading}>
          <Button variant="secondary" size="sm" disabled={checking} onClick={engine?.accepted ? checkUpdate : openGate}>
            {checking ? <Spinner className="size-3.5" /> : null}
            {engine?.accepted ? "Check for update" : "Accept EULA"}
          </Button>
        </PageRow>
      </PageSection>

      <LanguageServers />
      <Dialog open={gateOpen} onOpenChange={setGateOpen}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>JetBrains EULA</DialogTitle>
            {eula ? <DialogDescription>intellij-server {eula.build}</DialogDescription> : null}
          </DialogHeader>
          {eula ? (
            <pre className="max-h-80 overflow-y-auto rounded-lg bg-muted/50 p-3 text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {eula.text}
            </pre>
          ) : note ? (
            <p className="text-xs text-destructive">{note}</p>
          ) : (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              Downloading the engine to read its license…
            </p>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
            <Button disabled={!eula} onClick={accept}>
              Accept and enable
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
