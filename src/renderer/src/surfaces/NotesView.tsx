import { Plus, Search, File, Trash2 } from "../chrome/icons";
import { Button } from "../components/ui/button";
import { Tip, TruncateTip } from "../components/tip";
import { Spinner } from "../components/ui/spinner";
import { GroupInput, Input, InputGroup } from "../components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Textarea } from "../components/ui/textarea";
import { EmptyState, SurfaceSkeleton } from "./SurfaceSkeleton";
import { ConfirmDialog } from "../chrome/ConfirmDialog";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useMarkdownMode } from "../chrome/MarkdownModeToggle";
import { ProjectLogoIcon } from "../chrome/ProjectLogoIcon";
import { ProjectMascot } from "../chrome/ProjectMascot";
import { OverlayNav } from "../chrome/TitleBar";
import { WindowControls } from "../chrome/WindowControls";
import { useDragResize } from "../hooks/useDragResize";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { useTabGroupLogos } from "../hooks/useTabGroupLogos";
import { formatRelativeTime } from "../lib/githubTasks";
import {
  createNote,
  deleteNote,
  loadNotes,
  notePreview,
  noteSourceProject,
  noteTitle,
  upsertNote,
  requestAddNoteToChat,
  type Note,
} from "../lib/notes";
import { registry } from "../lib/connection";
import { hostOfCwd } from "../lib/tcserver/projects";
import { IS_MAC } from "../lib/platform";
import { looksLikeProject } from "../lib/recents";
import {
  loadTabGroupColors,
  loadTabGroupCustomColors,
  loadTabGroupMascots,
  resolveTabGroupColor,
  resolveTabGroupLogo,
  resolveTabGroupMascot,
} from "../lib/tabGroups";
import { AgentMarkdown, MarkdownSourceHighlight } from "./AgentMarkdown";

const MIN_WIDTH = 240;
const MAX_WIDTH = 420;
const DEFAULT_WIDTH = 280;

let rememberedWidth = DEFAULT_WIDTH;
let rememberedNoteId: string | null = null;
let focusedEnvironmentId: string | null = null;

/** Show this note, on this host, when the view next opens (a search hit). */
export function focusNote(environmentId: string, noteId: string): void {
  rememberedNoteId = noteId;
  focusedEnvironmentId = environmentId;
}

type Props = {
  besideRail?: boolean;
  cwd?: string;
  onClose: () => void;
  onToggleSidebar?: () => void;
};

export function NotesView({
  besideRail = false,
  cwd,
  onClose,
  onToggleSidebar,
}: Props) {
  // Notes without a project use this machine’s host; a note opened from
  // search names its own host for this showing.
  const environmentId = focusedEnvironmentId ?? (cwd ? hostOfCwd(cwd) : registry.primary().environmentId);
  useEffect(
    () => () => {
      focusedEnvironmentId = null;
    },
    [],
  );
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const listLock = useLockOverscroll<HTMLDivElement>();
  const resize = useDragResize({
    min: MIN_WIDTH,
    max: () => Math.min(MAX_WIDTH, Math.round(window.innerWidth * 0.5)),
    defaultWidth: DEFAULT_WIDTH,
    initial: rememberedWidth,
    onCommit: (width) => {
      rememberedWidth = width;
    },
  });
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(rememberedNoteId);
  const [creating, setCreating] = useState(false);
  const logos = useTabGroupLogos();
  const [groupMascots] = useState(loadTabGroupMascots);
  const [groupColors] = useState(loadTabGroupColors);
  const [groupCustomColors] = useState(loadTabGroupCustomColors);

  const refresh = useCallback(async () => {
    try {
      const next = await loadNotes(environmentId, true);
      setNotes(next);
      setError(null);
      setSelectedId((current) => {
        const preferred = current ?? rememberedNoteId;
        if (preferred && next.some((note) => note.id === preferred)) {
          return preferred;
        }
        return next[0]?.id ?? null;
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [environmentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    rememberedNoteId = selectedId;
  }, [selectedId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return notes;
    return notes.filter((note) => {
      const project = noteSourceProject(note.sourceCwd)?.toLowerCase() ?? "";
      return (
        note.title.toLowerCase().includes(needle) ||
        note.body.toLowerCase().includes(needle) ||
        note.slug.toLowerCase().includes(needle) ||
        project.includes(needle)
      );
    });
  }, [notes, query]);

  const selected =
    visible.find((note) => note.id === selectedId) ??
    notes.find((note) => note.id === selectedId) ??
    null;

  const onCreate = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const note = await createNote(environmentId, {
        title: "Untitled",
        body: "",
        ...(cwd && looksLikeProject(cwd) ? { sourceCwd: cwd } : {}),
      });
      setNotes(await loadNotes(environmentId, true));
      setSelectedId(note.id);
      setQuery("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const onSaved = (note: Note) => {
    setNotes((current) => {
      const next = current.map((item) => (item.id === note.id ? note : item));
      next.sort(
        (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
      );
      return next;
    });
  };

  const onDelete = async (id: string) => {
    try {
      await deleteNote(environmentId, id);
      const next = await loadNotes(environmentId, true);
      setNotes(next);
      setSelectedId((current) => {
        if (current !== id) return current;
        return next[0]?.id ?? null;
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onAddToChat = (note: Note) => {
    requestAddNoteToChat(note);
    onClose();
  };

  const list = (
    <div
      ref={resize.setPaneRef}
      className="relative flex h-full min-h-0 shrink-0 flex-col border-r border-border"
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-border p-2">
        <InputGroup className="flex-1" leading={<Search />}>
          <GroupInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter notes"
            aria-label="Filter notes"
            spellCheck={false}
            autoComplete="off"
          />
        </InputGroup>
        <Tip label="New note">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="New note"
          disabled={creating}
          onClick={() => void onCreate()}
          className="shrink-0 text-muted-foreground"
        >
          {creating ? (
            <Spinner className="size-3.5" />
          ) : (
            <Plus className="size-3.5" strokeWidth={1.75} />
          )}
        </Button>
        </Tip>
      </div>
      <div
        ref={listLock}
        className="min-h-0 flex-1 overflow-y-auto overscroll-none"
      >
        {error && notes.length === 0 ? (
          <p className="px-3 py-2 text-[12px] text-destructive">{error}</p>
        ) : loading && notes.length === 0 ? (
          <SurfaceSkeleton kind="rows" count={6} label="Loading notes" />
        ) : visible.length === 0 ? (
          <EmptyState title={query.trim() ? "No matching notes" : "No notes yet"} />
        ) : (
          <ul className="flex flex-col gap-0.5 p-1.5">
            {visible.map((note) => (
              <li key={note.id}>
                <NoteCard
                  note={note}
                  active={selected?.id === note.id}
                  logos={logos}
                  mascots={groupMascots}
                  colors={groupColors}
                  customColors={groupCustomColors}
                  onSelect={() => setSelectedId(note.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize notes list"
        className={`absolute inset-y-0 -right-px z-10 w-1.5 cursor-col-resize touch-none ${
          resize.dragging ? "bg-foreground/12" : "hover:bg-foreground/7"
        }`}
        onPointerDown={resize.onPointerDown}
        onDoubleClick={resize.onDoubleClick}
      />
    </div>
  );

  return (
    <div
      role="region"
      aria-label="Notes"
      data-app-notes
      className="flex min-h-0 min-w-0 flex-1 flex-col text-foreground"
    >
      <div
        className="flex h-10 shrink-0 select-none items-center border-b border-border"
        data-tauri-drag-region="deep"
      >
        {IS_MAC && !besideRail ? <div className="w-[78px] shrink-0" /> : null}
        {besideRail ? null : (
          <OverlayNav onBack={onClose} onToggleSidebar={onToggleSidebar} />
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <File
            className="size-3.5 shrink-0 text-muted-foreground"
            strokeWidth={1.75}
          />
          <span className="min-w-0 truncate text-foreground">Notes</span>
        </div>
        {IS_MAC ? null : <WindowControls />}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1">
        {list}
        <NoteDetail
          environmentId={environmentId}
          note={selected}
          logos={logos}
          mascots={groupMascots}
          colors={groupColors}
          customColors={groupCustomColors}
          onSaved={onSaved}
          onDelete={onDelete}
          onAddToChat={onAddToChat}
        />
      </div>
    </div>
  );
}

type ProjectMarks = {
  logos: Record<string, string>;
  mascots: Record<string, string>;
  colors: Record<string, number>;
  customColors: Record<string, string>;
};

function NoteProjectMark({
  project,
  logos,
  mascots,
  colors,
  customColors,
}: { project: string } & ProjectMarks) {
  const logoPath = resolveTabGroupLogo(project, logos);
  const mascotName = resolveTabGroupMascot(project, mascots);
  const mascotColor = resolveTabGroupColor(
    project,
    colors,
    customColors,
    project,
  );
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {logoPath ? (
        <ProjectLogoIcon
          path={logoPath}
          className="size-3.5 shrink-0 rounded-md"
          imageClassName="size-3.5"
        />
      ) : (
        <ProjectMascot
          project={project}
          color={mascotColor}
          name={mascotName}
          className="size-3 shrink-0"
        />
      )}
      <span className="min-w-0 truncate">{project}</span>
    </span>
  );
}

function NoteCard({
  note,
  active,
  logos,
  mascots,
  colors,
  customColors,
  onSelect,
}: {
  note: Note;
  active: boolean;
  onSelect: () => void;
} & ProjectMarks) {
  const preview = notePreview(note.body, note.title);
  const project = noteSourceProject(note.sourceCwd);
  const time = formatRelativeTime(new Date(note.updatedAt).toISOString());
  return (
    <Button
      variant="ghost"
      aria-current={active ? "true" : undefined}
      onClick={onSelect}
      className={`h-auto w-full flex-col items-stretch justify-start gap-0 whitespace-normal rounded-md px-2.5 py-2 text-left font-normal transition-none active:not-aria-[haspopup]:scale-100 ${
        active ? "bg-muted hover:bg-muted" : "hover:bg-foreground/5"
      }`}
    >
      <span className="flex items-center gap-2">
        {project ? (
          <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
            <NoteProjectMark
              project={project}
              logos={logos}
              mascots={mascots}
              colors={colors}
              customColors={customColors}
            />
          </span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {time ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {time}
          </span>
        ) : null}
      </span>
      <TruncateTip text={note.title}>
        <span className="mt-1 block truncate text-[13px] font-medium leading-snug text-foreground">{note.title}</span>
      </TruncateTip>
      {preview ? (
        <span className="mt-0.5 line-clamp-1 text-[12px] leading-snug text-muted-foreground">
          {preview}
        </span>
      ) : null}
    </Button>
  );
}

function NoteDetail({
  environmentId,
  note,
  logos,
  mascots,
  colors,
  customColors,
  onSaved,
  onDelete,
  onAddToChat,
}: {
  environmentId: string;
  note: Note | null;
  onSaved: (note: Note) => void;
  onDelete: (id: string) => void | Promise<void>;
  onAddToChat: (note: Note) => void;
} & ProjectMarks) {
  if (!note) {
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <EmptyState title="Select a note" />
      </div>
    );
  }
  return (
    <NoteEditor
      key={`${environmentId}:${note.id}`}
      environmentId={environmentId}
      note={note}
      logos={logos}
      mascots={mascots}
      colors={colors}
      customColors={customColors}
      onSaved={onSaved}
      onDelete={onDelete}
      onAddToChat={onAddToChat}
    />
  );
}

function NoteEditor({
  environmentId,
  note,
  logos,
  mascots,
  colors,
  customColors,
  onSaved,
  onDelete,
  onAddToChat,
}: {
  environmentId: string;
  note: Note;
  onSaved: (note: Note) => void;
  onDelete: (id: string) => void | Promise<void>;
  onAddToChat: (note: Note) => void;
} & ProjectMarks) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const blank = !note.body.trim() && note.title === "Untitled";
  const [mode, setMode] = useMarkdownMode(note.id);
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const titleRef = useRef(title);
  const bodyRef = useRef(body);
  const noteRef = useRef(note);
  const skipSave = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const saveQueue = useRef(Promise.resolve());
  const onSavedRef = useRef(onSaved);
  titleRef.current = title;
  bodyRef.current = body;
  noteRef.current = note;
  onSavedRef.current = onSaved;
  const project = noteSourceProject(note.sourceCwd);
  const time = formatRelativeTime(new Date(note.updatedAt).toISOString());

  useEffect(() => {
    if (blank) setMode("source");
    // New untitled notes open in source so typing isn't behind the preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = useCallback(async () => {
    if (skipSave.current) return;
    const current = noteRef.current;
    const nextTitle = titleRef.current.trim() || noteTitle(bodyRef.current);
    const nextBody = bodyRef.current;
    if (nextTitle === current.title && nextBody === current.body) return;
    try {
      const saved = await upsertNote(environmentId, {
        id: current.id,
        title: nextTitle,
        body: nextBody,
      });
      setSaveError(null);
      if (
        titleRef.current.trim() === "" ||
        titleRef.current === current.title
      ) {
        setTitle(saved.title);
      }
      onSavedRef.current(saved);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }, [environmentId]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      saveQueue.current = saveQueue.current.then(persist, persist);
    }, 400);
  }, [persist]);

  useEffect(() => {
    return () => {
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
      void persist();
    };
  }, [persist]);

  const onTitleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.currentTarget.blur();
  };

  const canAddToChat = Boolean(body.trim());
  const draft: Note = {
    ...note,
    title: title.trim() || noteTitle(body),
    body,
  };

  return (
    <div
      ref={lockOverscroll}
      className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-none"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-8 py-8">
        <header className="flex flex-col gap-3">
          {note.slug || project ? (
            <div className="flex min-w-0 items-center gap-3 text-[12px] text-muted-foreground">
              {note.slug ? (
                <span className="min-w-0 truncate">{note.slug}</span>
              ) : null}
              {project ? (
                <NoteProjectMark
                  project={project}
                  logos={logos}
                  mascots={mascots}
                  colors={colors}
                  customColors={customColors}
                />
              ) : null}
            </div>
          ) : null}
          <Input
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              scheduleSave();
            }}
            onBlur={() => {
              const next = title.trim() || noteTitle(body);
              if (next !== title) setTitle(next);
              void persist();
            }}
            onKeyDown={onTitleKeyDown}
            aria-label="Note title"
            className="h-auto rounded-none border-0 p-0 text-[16px] font-semibold leading-snug tracking-[-0.01em] text-foreground shadow-none!"
            placeholder="Untitled"
          />
          {time ? (
            <div className="text-[12px] text-muted-foreground tabular-nums">Updated {time}</div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="sm" disabled={!canAddToChat} onClick={() => onAddToChat(draft)}>
              Add to chat
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmDelete(true)}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 strokeWidth={1.75} />
              Delete
            </Button>
          </div>
          {confirmDelete ? (
            <ConfirmDialog
              title="Delete note?"
              body="The note is gone for good."
              confirmLabel="Delete"
              danger
              onCancel={() => setConfirmDelete(false)}
              onConfirm={async () => {
                skipSave.current = true;
                if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
                await onDelete(note.id);
              }}
            />
          ) : null}
          {saveError ? (
            <p className="text-[12px] text-destructive">{saveError}</p>
          ) : null}
        </header>
        <Tabs value={mode} onValueChange={(next) => setMode(next as typeof mode)}>
          <TabsList
            variant="line"
            aria-label="Note sections"
            className="h-9 w-full justify-start gap-4 border-b border-border"
          >
            <TabsTrigger value="preview" className="flex-none">
              Preview
            </TabsTrigger>
            <TabsTrigger value="source" className="flex-none">
              Source
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {mode === "source" ? (
          <NoteSource
            autoFocus={blank}
            value={body}
            onChange={(next) => {
              setBody(next);
              scheduleSave();
            }}
          />
        ) : body.trim() ? (
          <AgentMarkdown text={body} cwd={note.sourceCwd} />
        ) : (
          <p className="text-[13px] text-muted-foreground">No description</p>
        )}
      </div>
    </div>
  );
}

function NoteSource({
  value,
  onChange,
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  const lines = value.split("\n");
  const gutterWidth = `calc(${Math.max(String(lines.length).length, 2)}ch + 0.75rem)`;
  const textOffset = `calc(${gutterWidth} + 0.75rem)`;

  return (
    <div className="relative min-h-[448px]">
      <div
        aria-hidden
        className="pointer-events-none grid font-mono text-[13px] leading-5 text-foreground"
        style={{
          gridTemplateColumns: `${gutterWidth} minmax(0, 1fr)`,
        }}
      >
        {lines.map((line, index) => (
          <Fragment key={index}>
            <div className="select-none pr-2 text-right tabular-nums whitespace-nowrap text-muted-foreground">
              {index + 1}
            </div>
            <div className="min-h-5 min-w-0 pl-3 whitespace-pre-wrap wrap-break-word">
              {line ? <MarkdownSourceHighlight text={line} /> : "\u00a0"}
            </div>
          </Fragment>
        ))}
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 w-px bg-border"
        style={{ left: gutterWidth }}
      />
      <Textarea
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        aria-label="Note source"
        placeholder="Write markdown…"
        className="markdown-source-field absolute inset-0 block h-full min-h-0 w-full resize-none overflow-hidden rounded-none border-0 py-0 pr-0 font-mono leading-5 whitespace-pre-wrap wrap-break-word shadow-none! field-sizing-fixed"
        style={{ paddingLeft: textOffset }}
      />
    </div>
  );
}
