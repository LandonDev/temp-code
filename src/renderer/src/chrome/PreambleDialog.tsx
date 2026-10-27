import { Suspense, lazy, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { Modal, useModalClose } from "./Modal";
import { DialogFooter as Footer, ErrorLine, errorText } from "./ConfirmDialog";
import { Field, FieldRow, Tip } from "./DialogField";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { setProjectPreamble, setWorkspacePreamble } from "../lib/tcserver/projects";
import type { ProjectMeta, WorkspaceMeta } from "../lib/tcserver/types";
import { useProjectHome } from "../lib/projectHome";
import { PREAMBLE_VARIABLES, normalizePreamble, wordCount } from "@server/shared/preamble";

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

const PLACEHOLDER = `- Work in your own worktree: \`{{worktree}}\`.
- Typecheck, tests and build green before you merge.
- Never touch what is not yours.`;

const words = (n: number) => `${n} word${n === 1 ? "" : "s"}`;

/**
 * The preamble editor: the markdown every thread in the scope opens with
 * (prepended by the main process to its first message as "## Project
 * rules") beside a live preview of how it reads, the word count the
 * transcript row will show, and the switch that keeps the text while
 * nothing is prepended. Saving reaches new threads only. A linked project's preamble
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

type EditorProps = {
  scope: PreambleScope;
  onClose: () => void;
  note?: string;
  blocked?: string | null;
};

function PreambleEditor(props: EditorProps) {
  const { scope } = props;
  const [pending, setPending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  // The caret opens at the end of the text.
  const focusText = () => {
    const el = ref.current;
    el?.setSelectionRange(el.value.length, el.value.length);
    return el ?? true;
  };
  const title = scope.kind === "project" ? "Preamble" : "Workspace preamble";
  const description =
    scope.kind === "project"
      ? `Opens every new thread in ${scope.project.name}.`
      : `The default for projects in ${scope.workspace.name} without their own.`;
  return (
    <Modal onClose={props.onClose} busy={pending} title={title} description={description} size="lg" initialFocus={focusText}>
      <PreambleForm {...props} textRef={ref} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function PreambleForm({
  scope,
  onClose,
  note,
  blocked = null,
  textRef,
  pending,
  setPending,
}: EditorProps & {
  textRef: RefObject<HTMLTextAreaElement | null>;
  pending: boolean;
  setPending: (pending: boolean) => void;
}) {
  const own = scope.kind === "project" ? scope.project : scope.workspace;
  const saved = own.preamble ?? "";
  const savedEnabled = own.preambleEnabled !== false;
  const [text, setText] = useState(saved);
  const [enabled, setEnabled] = useState(savedEnabled);
  const [error, setError] = useState<string | null>(null);
  const close = useModalClose();

  const normalized = normalizePreamble(text);
  const count = useMemo(() => wordCount(text), [text]);
  const dirty = normalized !== normalizePreamble(saved) || enabled !== savedEnabled;
  // A project with no text of its own falls back to the workspace default;
  // the preview says so, with the count a thread would carry.
  const fallback = scope.kind === "project" ? normalizePreamble(scope.workspace.preamble) : null;
  const fallbackApplies = scope.kind === "project" && scope.workspace.preambleEnabled !== false;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || pending || blocked) return;
    setPending(true);
    setError(null);
    try {
      if (scope.kind === "project") await setProjectPreamble(scope.project.id, normalized, enabled);
      else await setWorkspacePreamble(scope.workspace.id, normalized, enabled);
      if (close) close(onClose);
      else onClose();
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void submit(e);
        }
      }}
    >
      <div className="flex flex-col gap-4 px-4 py-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Project rules" aside={<span className="text-xs tabular-nums text-muted-foreground" data-preamble-count>{words(count)}</span>}>
            <Textarea
              ref={textRef}
              value={text}
              spellCheck={false}
              placeholder={PLACEHOLDER}
              onChange={(e) => setText(e.target.value)}
              className="h-64 resize-none field-sizing-fixed"
            />
          </Field>
          <section aria-label="Preview" className="flex min-w-0 flex-col gap-1">
            <h3 className="text-xs font-medium text-muted-foreground">Preview</h3>
            <ScrollArea className="h-64 rounded-lg border border-border bg-card">
              <div className="px-3 py-2 text-[13px] [&_h1]:text-[13px] [&_h2]:text-[13px] [&_h3]:text-xs [&_h4]:text-xs" data-preamble-preview>
                {normalized ? (
                  <Suspense fallback={<pre className="whitespace-pre-wrap font-sans text-xs leading-5">{normalized}</pre>}>
                    <AgentMarkdown text={normalized} className="!text-xs !leading-5" />
                  </Suspense>
                ) : scope.kind === "project" && fallback ? (
                  <p className="text-xs text-muted-foreground" data-preamble-fallback>
                    Empty: threads take the workspace default ({words(wordCount(fallback))}
                    {fallbackApplies ? "" : ", switched off"}).
                  </p>
                ) : null}
              </div>
            </ScrollArea>
          </section>
        </div>
        <div className="flex flex-col">
          <FieldRow label="Apply to new threads" description={enabled ? undefined : "Kept, but nothing is prepended."} className="-my-2">
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </FieldRow>
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="flex gap-2 font-mono text-[11px] text-muted-foreground" data-preamble-variables>
            {PREAMBLE_VARIABLES.map((v) => (
              <Tip key={v.name} label={`${v.meaning}, filled in when the thread starts`}>
                {/* Focusable, and named for its meaning, so the help is not hover-only. */}
                <code tabIndex={0} aria-label={`{{${v.name}}}: ${v.meaning}`} className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">{`{{${v.name}}}`}</code>
              </Tip>
            ))}
          </p>
          {scope.kind === "project" && normalized ? (
            <Button type="button" variant="link" size="xs" className="h-auto px-0 text-muted-foreground hover:text-foreground" onClick={() => setText("")}>
              Use workspace default
            </Button>
          ) : null}
        </div>
        <ErrorLine error={error} />
      </div>
      <Footer onCancel={onClose} confirmLabel="Save" pending={pending} disabled={!dirty || !!blocked} note={note} />
    </form>
  );
}
