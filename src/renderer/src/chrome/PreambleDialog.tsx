import { Suspense, lazy, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Modal } from "./Modal";
import { DialogFooter as Footer, ErrorLine, GHOST, errorText } from "./ConfirmDialog";
import { Toggle } from "../surfaces/settingsBits";
import { setProjectPreamble, setWorkspacePreamble } from "../lib/tcserver/projects";
import type { ProjectMeta, WorkspaceMeta } from "../lib/tcserver/types";
import { useProjectHome } from "../lib/projectHome";
import {
  PREAMBLE_VARIABLES,
  normalizePreamble,
  wordCount,
} from "@server/shared/preamble";

/** What the dialog edits: a project's own preamble, or the workspace's
 *  default for its projects without one. */
export type PreambleScope =
  | { kind: "project"; project: ProjectMeta; workspace: WorkspaceMeta }
  | { kind: "workspace"; workspace: WorkspaceMeta };

// The transcript's markdown renderer, loaded when a preview first shows: it
// is heavy, and nothing else on the sidebar's path needs it.
const AgentMarkdown = lazy(() =>
  import("../surfaces/AgentMarkdown").then((m) => ({ default: m.AgentMarkdown })),
);

const LABEL = "text-[11px] font-medium text-content/50";
const TEXTAREA =
  "min-h-[9.5rem] w-full resize-y rounded-lg border border-content/10 bg-content/5 px-2.5 py-2 font-sans text-[12px] leading-5 text-content outline-none placeholder:text-content/40 focus:border-content/20 disabled:cursor-default disabled:opacity-40";

const PLACEHOLDER = `- Work in your own worktree: \`{{worktree}}\`.
- Typecheck, tests and build green before you merge.
- Never touch what is not yours.`;

const words = (n: number) => `${n} word${n === 1 ? "" : "s"}`;

/**
 * The preamble editor: the markdown every thread in the scope opens with
 * (prepended by the main process to its first message as "## Project
 * rules"), a live preview of how it reads, the word count the transcript
 * row will show, and the switch that keeps the text while nothing is
 * prepended. Saving reaches new threads only. A linked project's preamble
 * lives on its settings home (lib/projectHome.ts): read from and saved to
 * that copy, the footer saying where, Save off while the home is offline.
 */
export function PreambleDialog({ scope, onClose }: { scope: PreambleScope; onClose: () => void }) {
  return scope.kind === "project" ? (
    <ProjectPreambleDialog scope={scope} onClose={onClose} />
  ) : (
    <PreambleEditor scope={scope} onClose={onClose} />
  );
}

function ProjectPreambleDialog({
  scope,
  onClose,
}: {
  scope: Extract<PreambleScope, { kind: "project" }>;
  onClose: () => void;
}) {
  const at = useProjectHome(scope.project);
  return (
    <PreambleEditor
      key={`${at.home.environmentId}:${at.home.id}`}
      scope={{ kind: "project", project: at.home, workspace: at.workspace ?? scope.workspace }}
      note={at.blocked ?? (at.linked ? `Saved on ${at.hostName}` : undefined)}
      blocked={at.blocked}
      onClose={onClose}
    />
  );
}

function PreambleEditor({
  scope,
  onClose,
  note,
  blocked = null,
}: {
  scope: PreambleScope;
  onClose: () => void;
  note?: string;
  blocked?: string | null;
}) {
  const own = scope.kind === "project" ? scope.project : scope.workspace;
  const saved = own.preamble ?? "";
  const savedEnabled = own.preambleEnabled !== false;
  const [text, setText] = useState(saved);
  const [enabled, setEnabled] = useState(savedEnabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const normalized = normalizePreamble(text);
  const count = useMemo(() => wordCount(text), [text]);
  const dirty = normalized !== normalizePreamble(saved) || enabled !== savedEnabled;
  // A project with no text of its own falls back to the workspace default;
  // the row says so, with the count a thread would carry.
  const fallback =
    scope.kind === "project" ? normalizePreamble(scope.workspace.preamble) : null;
  const fallbackApplies = scope.kind === "project" && scope.workspace.preambleEnabled !== false;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || pending || blocked) return;
    setPending(true);
    setError(null);
    try {
      if (scope.kind === "project") await setProjectPreamble(scope.project.id, normalized, enabled);
      else await setWorkspacePreamble(scope.workspace.id, normalized, enabled);
      onClose();
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };

  const title = scope.kind === "project" ? "Preamble" : "Workspace preamble";
  const description =
    scope.kind === "project"
      ? `Opens every new thread in ${scope.project.name}`
      : `The default for projects in ${scope.workspace.name} without their own`;

  return (
    <Modal onClose={onClose} busy={pending} title={title} description={description} size="md">
      <form
        onSubmit={submit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit(e);
          }
        }}
      >
        <div className="flex flex-col gap-3 px-4 py-3">
          <label className="flex flex-col gap-1">
            <span className="flex items-baseline justify-between">
              <span className={LABEL}>Project rules</span>
              <span className="text-[11px] tabular-nums text-content/40">{words(count)}</span>
            </span>
            <textarea
              ref={ref}
              value={text}
              rows={8}
              spellCheck={false}
              placeholder={PLACEHOLDER}
              onChange={(e) => setText(e.target.value)}
              className={TEXTAREA}
            />
          </label>
          {normalized ? (
            <div className="flex flex-col gap-1">
              <span className={LABEL}>Preview</span>
              <div className="max-h-56 overflow-y-auto rounded-lg border border-content/10 px-3 py-2 text-content/80 [&_h1]:text-[13px] [&_h2]:text-[13px] [&_h3]:text-[12px] [&_h4]:text-[12px]">
                <Suspense fallback={<pre className="whitespace-pre-wrap font-sans text-[12px] leading-5">{normalized}</pre>}>
                  <AgentMarkdown text={normalized} className="!text-[12px] !leading-5" />
                </Suspense>
              </div>
            </div>
          ) : scope.kind === "project" && fallback ? (
            <p className="text-[11px] leading-4 text-content/40">
              Empty: threads take the workspace default ({words(wordCount(fallback))}
              {fallbackApplies ? "" : ", switched off"}).
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-3 border-t border-content/10 pt-3">
            <span className="flex flex-col">
              <span className="text-[12px] text-content">Apply to new threads</span>
              <span className="text-[11px] leading-4 text-content/40">
                {enabled
                  ? "The rules open each thread's first message. Threads already running keep theirs."
                  : "Kept, but nothing is prepended."}
              </span>
            </span>
            <Toggle label="Apply to new threads" on={enabled} onChange={setEnabled} />
          </div>
          {scope.kind === "project" && normalized ? (
            <button
              type="button"
              onClick={() => setText("")}
              className={`${GHOST} self-start`}
            >
              Use workspace default
            </button>
          ) : null}
          <p className="text-[11px] leading-4 text-content/40">
            {PREAMBLE_VARIABLES.map((v, i) => (
              <span key={v.name}>
                {i > 0 ? " · " : ""}
                <code className="rounded bg-content/5 px-1 font-mono text-[10.5px] text-content/60">{`{{${v.name}}}`}</code>{" "}
                {v.meaning}
              </span>
            ))}
            . Substituted when the thread starts.
          </p>
          <ErrorLine error={error} />
        </div>
        <Footer
          onCancel={onClose}
          confirmLabel="Save"
          pending={pending}
          disabled={!dirty || !!blocked}
          note={note}
        />
      </form>
    </Modal>
  );
}
