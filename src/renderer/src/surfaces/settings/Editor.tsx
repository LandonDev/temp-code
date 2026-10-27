import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { MOD } from "../../lib/platform";
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
import { Modal } from "../../chrome/Modal";
import { Row, SecondaryButton, Toggle } from "../settingsBits";
import { GHOST, PRIMARY } from "../../chrome/ConfirmDialog";
import { MatrixSpinner } from "../threads/bits";

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

function lspRowStatus(row: LspStatusRow): string {
  if (row.state === "running") {
    const parts = [row.memoryBytes != null ? fmtBytes(row.memoryBytes) : "running"];
    if (row.idleMs > 60_000) parts.push(`idle ${Math.round(row.idleMs / 60_000)}m`);
    return parts.join(" · ");
  }
  if (row.state === "error") return row.error ?? "error";
  return `${row.state}…`;
}

/** Live language-server rows, polled while the page is open. M7a's push
 *  of readiness changes can replace the poll once it lands. */
function LanguageServersRow() {
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
    <Row
      label="Language servers"
      description={
        rows === null ? (
          <MatrixSpinner cell={1.5} />
        ) : rows.length === 0 ? (
          "None running."
        ) : undefined
      }
    >
      {rows && rows.length > 0 ? (
        <div className="flex flex-col items-end gap-1 text-[12px]">
          {rows.map((row) => (
            <span key={row.serverId} className="flex items-center gap-2">
              <span className="text-content">{LSP_LABEL[row.lang]}</span>
              <span className="text-content/40">
                {projectNames.get(row.projectId) ?? row.projectId}
              </span>
              <span
                className={`tabular-nums ${row.state === "error" ? "text-danger" : "text-content/40"}`}
              >
                {lspRowStatus(row)}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </Row>
  );
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

  const checkUpdate = () => {
    setNote("Checking…");
    void registry.primary()
      .request<{ current: string; latest: string; updated: boolean }>("idea.checkUpdate")
      .then((r) => {
        setNote(r.updated ? `Updated to ${r.latest}. Accept the EULA again.` : "Up to date.");
        refreshEngine();
      })
      .catch(() => setNote("Update check failed."));
  };

  const jdkState =
    java === undefined
      ? null
      : !java || !java.found
        ? (java?.error ?? "No JDK found. Install JDK 21 or newer for Java.")
        : java.error
          ? `JDK ${java.version} — needs 21+`
          : `JDK ${java.version} · ${java.jdtls ? "jdtls ready" : "jdtls downloads on first use"}`;

  const engineState =
    engine === undefined
      ? null
      : !engine || !engine.dist
        ? "Not downloaded"
        : engine.accepted
          ? `Ready · build ${engine.build}`
          : "Needs the EULA";

  return (
    <>
      <Row label="Auto save" description={`Write 800 ms after the last keystroke (${MOD}S writes at once).`}>
        <Toggle
          label="Auto save"
          on={autoSave}
          onChange={(on) => {
            saveAutoSave(on);
            setAutoSave(on);
          }}
        />
      </Row>
      <Row label="Format on save">
        <span className="flex items-center gap-2">
          <span className="text-[12px] text-content/50">Java</span>
          <Toggle label="Format Java on save" on={formatOnSave.java} onChange={(on) => onFormat({ java: on })} />
        </span>
        <span className="ml-2 flex items-center gap-2">
          <span className="text-[12px] text-content/50">Web</span>
          <Toggle label="Format TypeScript and JavaScript on save" on={formatOnSave.web} onChange={(on) => onFormat({ web: on })} />
        </span>
      </Row>
      <Row label="Ghost text" description="Inline completions from Claude on your existing login.">
        <Toggle
          label="Ghost text"
          on={ghostText}
          onChange={(on) => {
            saveGhostText(on);
            setGhostText(on);
          }}
        />
      </Row>
      <Row
        label="JDK"
        description={
          <>
            <span className={`block ${java && java.error ? "text-warning" : ""}`}>
              {jdkState ?? <MatrixSpinner cell={1.5} />}
            </span>
            {java?.path ? (
              <span className="block truncate font-mono text-[11px] text-content/40">
                {java.path}
              </span>
            ) : null}
          </>
        }
      />
      <Row label="IntelliJ engine" description={note ?? engineState ?? <MatrixSpinner cell={1.5} />}>
        {engine?.accepted ? (
          <SecondaryButton onClick={checkUpdate}>Check for update</SecondaryButton>
        ) : (
          <SecondaryButton onClick={openGate}>Accept EULA</SecondaryButton>
        )}
      </Row>
      <LanguageServersRow />
      {gateOpen ? (
        <Modal
          onClose={() => setGateOpen(false)}
          title="JetBrains EULA"
          description={`intellij-server ${eula?.build ?? ""}`.trim()}
          size="md"
        >
          <div className="px-4 py-3">
            {eula ? (
              <pre className="max-h-80 overflow-y-auto rounded-[10px] border border-content/10 p-3 text-[11px] leading-relaxed whitespace-pre-wrap text-content/70">
                {eula.text}
              </pre>
            ) : note ? (
              <p className="text-[12px] text-danger">{note}</p>
            ) : (
              <p className="flex items-center gap-2 text-[12px] text-content/50">
                <MatrixSpinner cell={1.5} /> Downloading the engine to read its license…
              </p>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-content/10 px-4 py-3">
            <button type="button" onClick={() => setGateOpen(false)} className={GHOST}>
              Cancel
            </button>
            <button type="button" disabled={!eula} onClick={accept} className={PRIMARY}>
              Accept and enable
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
