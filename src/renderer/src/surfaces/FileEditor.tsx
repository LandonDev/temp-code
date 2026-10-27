import { acceptCompletion, completionStatus } from "@codemirror/autocomplete";
import { indentLess, indentMore } from "@codemirror/commands";
import {
  foldGutter,
  foldKeymap,
  getIndentUnit,
  indentUnit,
} from "@codemirror/language";
import {
  Annotation,
  Compartment,
  countColumn,
  EditorSelection,
  Prec,
  StateField,
  Transaction,
  EditorState,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { RotateCcw } from "../chrome/icons";
import { Button } from "../components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Skeleton } from "../components/ui/skeleton";
import { minimalSetup } from "codemirror";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { useMarkdownMode } from "../chrome/MarkdownModeToggle";
import { useColorScheme } from "../hooks/useColorScheme";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { isLightScheme } from "../lib/appearance";
import { formatText } from "../lib/format";
import {
  basename,
  gitFileDiff,
  gitStageContents,
  notifyGitChanged,
  readTextFile,
  subscribeGitChanged,
  writeTextFile,
} from "../lib/fs";
import { registerEditorFlusher } from "../lib/editorFlush";
import { loadAutoSave } from "../lib/settings";
import { syncWatchedMtime, watchFile } from "../lib/fileWatch";
import { hostOfCwd } from "../lib/tcserver/projects";
import { openFailureText } from "../lib/pathHost";
import { registry } from "../lib/connection";
import { displayPath } from "../lib/paths";
import type { EditorNavigation } from "../lib/search";
import { MarkdownPreview } from "./AgentMarkdown";
import { FileHeader, fileFolder, type SaveState } from "./FileHeader";
import { editorAutocomplete } from "./editorAutocomplete";
import { languageForPath, schemeExtensions } from "./editorChrome";
import { preserveEditorViewport, replaceEditorDoc } from "./editorDoc";
import { editorMatching, editorTyping, tryExpandEmmet } from "./editorEditing";
import {
  diffActiveChunkIndex,
  diffLineStatsForView,
  diffNavigablePositions,
  diffNavUpdateRelevant,
  diffScrollToChunk,
  editorGit,
  setGitOriginal,
} from "./editorGit";
import { editorLint } from "./editorLint";
import { editorSearch } from "./editorSearch";

type EditorNavigationRequest = EditorNavigation & { token: number };

const editorScheme = new Compartment();

type Props = {
  path: string;
  cwd: string;
  /** The host the file is read from; absent, the catalog decides from the path. */
  environmentId?: string;
  active: boolean;
  showDiff?: boolean;
  navigation?: EditorNavigationRequest | null;
  onDirtyChange: (path: string, dirty: boolean) => void;
  onErrorCountChange?: (path: string, count: number) => void;
  onOpenFile?: (path: string) => void;
  /** No edits: the file is shown as another host holds it. */
  readOnly?: boolean;
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; content: string }
  | { status: "error"; message: string };

/** Where the review tab's diff stands: its hunks and the one in view. */
type ChunkNav = {
  positions: number[];
  index: number;
  additions: number;
  deletions: number;
};

export function FileEditor({
  path,
  cwd,
  environmentId,
  active,
  showDiff = false,
  navigation,
  onDirtyChange,
  onErrorCountChange,
  onOpenFile,
  readOnly = false,
}: Props) {
  const host = environmentId ?? hostOfCwd(path);
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" });
  const [reloadKey, setReloadKey] = useState(0);
  const [draft, setDraft] = useState("");
  const [gitBase, setGitBase] = useState<{
    path: string;
    original: string | null;
  }>({ path, original: null });
  const markdown = isMarkdownPath(path);
  const [mode, setMode] = useMarkdownMode(path);
  const [chunkNav, setChunkNav] = useState<ChunkNav | null>(null);
  const stepChunk = useRef<((delta: -1 | 1) => void) | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const saveGeneration = useRef(0);
  const loadGeneration = useRef(0);
  const dirtyRef = useRef(false);
  const pendingDiskRef = useRef(false);
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

  const applyDiskContent = useCallback((content: string) => {
    setLoadState((current) => {
      if (current.status === "ready" && current.content === content) {
        return current;
      }
      return { status: "ready", content };
    });
    setDraft(content);
  }, []);

  const reloadFromDisk = useCallback(
    async (force = false) => {
      const generation = ++loadGeneration.current;
      try {
        const content = await readTextFile(host, path);
        if (generation !== loadGeneration.current) return;
        if (dirtyRef.current && !force) {
          pendingDiskRef.current = true;
          return;
        }
        pendingDiskRef.current = false;
        if (force && dirtyRef.current) {
          dirtyRef.current = false;
          onDirtyChangeRef.current(path, false);
        }
        applyDiskContent(content);
      } catch (error: unknown) {
        if (generation !== loadGeneration.current) return;
        if (dirtyRef.current && !force) {
          pendingDiskRef.current = true;
          return;
        }
        setLoadState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [applyDiskContent, path, host],
  );

  useEffect(() => {
    dirtyRef.current = false;
    pendingDiskRef.current = false;
    let cancelled = false;
    setLoadState({ status: "loading" });
    setSaveState({ status: "idle" });
    const generation = ++loadGeneration.current;
    void readTextFile(host, path)
      .then((content) => {
        if (cancelled || generation !== loadGeneration.current) return;
        setLoadState({ status: "ready", content });
        setDraft(content);
      })
      .catch((error: unknown) => {
        if (cancelled || generation !== loadGeneration.current) return;
        setLoadState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [path, host, reloadKey]);

  useEffect(() => {
    if (!showDiff) {
      setGitBase({ path, original: null });
      return;
    }
    const relative = displayPath(path, cwd);
    if (!cwd || cwd === "~" || !relative || relative === path) {
      setGitBase({ path, original: null });
      return;
    }
    let cancelled = false;
    setGitBase({ path, original: null });

    const load = () => {
      void gitFileDiff(host, cwd, relative)
        .then((diff) => {
          if (cancelled) return;
          if (diff.binary || diff.tooLarge) {
            setGitBase({ path, original: null });
            return;
          }
          setGitBase({ path, original: diff.original });
        })
        .catch(() => {
          if (!cancelled) setGitBase({ path, original: null });
        });
    };

    load();
    const onFocus = () => {
      if (!document.hidden) load();
    };
    const onGit = () => {
      if (!document.hidden) load();
    };
    let timer = 0;
    const onDisk = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        load();
        void reloadFromDisk();
      }, 50);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const unsubGit = subscribeGitChanged(onGit);
    const unsubWatch = watchFile(path, onDisk, host);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      unsubGit();
      unsubWatch();
    };
  }, [cwd, path, reloadFromDisk, showDiff]);

  const gitOriginal = gitBase.path === path ? gitBase.original : null;

  useEffect(() => {
    if (loadState.status !== "ready") return;
    let timer = 0;
    const stop = watchFile(path, () => {
      if (dirtyRef.current) {
        pendingDiskRef.current = true;
        return;
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void reloadFromDisk();
      }, 50);
    }, host);
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [loadState.status, path, reloadFromDisk]);

  const save = useCallback(
    async (content: string) => {
      const generation = ++saveGeneration.current;
      setSaveState({ status: "saving" });
      const operation = saveQueue.current.then(() =>
        writeTextFile(host, path, content),
      );
      saveQueue.current = operation.catch(() => {});
      try {
        await operation;
        await syncWatchedMtime(path);
        notifyGitChanged();
        if (generation === saveGeneration.current) {
          setSaveState({ status: "saved" });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (generation === saveGeneration.current) {
          setSaveState({ status: "error", message });
        }
        throw error;
      }
    },
    [path],
  );

  const stageGit = useCallback(
    async (contents: string) => {
      const relative = displayPath(path, cwd);
      if (!cwd || cwd === "~" || !relative || relative === path) {
        throw new Error("Can't stage this file");
      }
      try {
        await gitStageContents(host, cwd, relative, contents);
        notifyGitChanged();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setSaveState({ status: "error", message });
        throw error;
      }
    },
    [cwd, path],
  );

  const dirtyChange = useCallback(
    (dirty: boolean) => {
      dirtyRef.current = dirty;
      onDirtyChange(path, dirty);
      if (dirty) {
        setSaveState((current) =>
          current.status === "saving" ? current : { status: "idle" },
        );
        return;
      }
      if (pendingDiskRef.current) {
        pendingDiskRef.current = false;
        void reloadFromDisk();
      }
    },
    [onDirtyChange, path, reloadFromDisk],
  );

  const errorCountChange = useCallback(
    (count: number) => onErrorCountChange?.(path, count),
    [onErrorCountChange, path],
  );

  const folder = fileFolder(path, cwd);
  if (loadState.status === "loading") return <EditorLoading name={basename(path)} />;

  if (loadState.status === "error") {
    return (
      <EditorOpenError
        name={basename(path)}
        line={openFailureText(
          loadState.message,
          host === registry.primaryEnvironmentId ? null : (registry.environment(host)?.name ?? "that host"),
        )}
        onRetry={() => setReloadKey((value) => value + 1)}
      />
    );
  }

  const editor = (
    <CodeMirrorEditor
      key={`${path}:${reloadKey}:${readOnly}`}
      path={path}
      value={loadState.content}
      readOnly={readOnly}
      showDiff={showDiff}
      gitOriginal={gitOriginal}
      active={markdown ? active && mode === "source" : active}
      navigation={navigation}
      onDirtyChange={dirtyChange}
      onErrorCountChange={errorCountChange}
      onSave={save}
      onStageGit={showDiff ? stageGit : undefined}
      onDocChange={markdown ? setDraft : undefined}
      onChunkNav={setChunkNav}
      stepRef={stepChunk}
    />
  );

  // The changes are in the source: a step from the Markdown preview shows it.
  const stepToChange = (delta: -1 | 1) => {
    if (markdown && mode === "preview") setMode("source");
    stepChunk.current?.(delta);
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <FileHeader
        folder={folder}
        save={saveState}
        markdown={markdown ? { mode, onModeChange: setMode } : undefined}
        diff={
          showDiff
            ? {
                additions: chunkNav?.additions ?? 0,
                deletions: chunkNav?.deletions ?? 0,
                index: chunkNav?.index ?? 0,
                total: chunkNav?.positions.length ?? 0,
                onPrev: () => stepToChange(-1),
                onNext: () => stepToChange(1),
              }
            : undefined
        }
      />
      {markdown ? (
        <div className="relative min-h-0 min-w-0 flex-1">
          <div className={mode === "preview" ? "absolute inset-0" : "pointer-events-none invisible absolute inset-0"}>
            <MarkdownPreview text={draft} cwd={cwd} onOpenFile={onOpenFile} />
          </div>
          <div
            className={
              mode === "source"
                ? "absolute inset-0 flex min-h-0 min-w-0 flex-col"
                : "pointer-events-none invisible absolute inset-0 flex min-h-0 min-w-0 flex-col"
            }
          >
            {editor}
          </div>
        </div>
      ) : (
        editor
      )}
    </div>
  );
}

/** Widths of the loading lines, fixed so nothing shifts between renders. */
const LOADING_LINES = [60, 82, 45, 70, 90, 38, 66, 52];

/** A file on its way: the header's slot, then bars in the shape of code. */
export function EditorLoading({ name }: { name: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={`Opening ${name}`} className="flex h-full min-h-0 flex-col">
      <div className="h-8 shrink-0 border-b border-border" />
      <div className="flex flex-col gap-2 px-3 pt-3">
        {LOADING_LINES.map((width, i) => (
          <Skeleton key={i} data-loading-line="" className="h-3" style={{ width: `${width}%` }} />
        ))}
      </div>
    </div>
  );
}

/** A file that did not open: what, why, and Retry. */
export function EditorOpenError({ name, line, onRetry }: { name: string; line: string; onRetry: () => void }) {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyTitle>Couldn’t open {name}</EmptyTitle>
        <EmptyDescription>{line}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RotateCcw />
          Retry
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function CodeMirrorEditor({
  path,
  value,
  showDiff,
  gitOriginal,
  active,
  navigation,
  onDirtyChange,
  onErrorCountChange,
  onSave,
  onStageGit,
  onDocChange,
  onChunkNav,
  stepRef,
  readOnly = false,
}: {
  path: string;
  value: string;
  readOnly?: boolean;
  showDiff: boolean;
  gitOriginal: string | null;
  active: boolean;
  navigation?: EditorNavigationRequest | null;
  onDirtyChange: (dirty: boolean) => void;
  onErrorCountChange: (count: number) => void;
  onSave: (content: string) => Promise<void>;
  onStageGit?: (contents: string) => Promise<void>;
  onDocChange?: (content: string) => void;
  /** The diff's hunks and the one in view, for the header's stepper. */
  onChunkNav: (nav: ChunkNav | null) => void;
  /** Filled with the step the header's buttons call. */
  stepRef: MutableRefObject<((delta: -1 | 1) => void) | null>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const savedDocumentRef = useRef<Text | null>(null);
  const dirtyRef = useRef(false);
  const activeRef = useRef(active);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const onErrorCountChangeRef = useRef(onErrorCountChange);
  const onSaveRef = useRef(onSave);
  const onStageGitRef = useRef(onStageGit);
  const onDocChangeRef = useRef(onDocChange);
  const valueRef = useRef(value);
  const gitOriginalRef = useRef(gitOriginal);
  const chunkNavPinnedRef = useRef<number | null>(null);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const colorScheme = useColorScheme();
  const [chunkNav, setChunkNav] = useState<ChunkNav | null>(null);
  const onChunkNavRef = useRef(onChunkNav);
  onChunkNavRef.current = onChunkNav;
  activeRef.current = active;
  onDirtyChangeRef.current = onDirtyChange;
  onErrorCountChangeRef.current = onErrorCountChange;
  onSaveRef.current = onSave;
  onStageGitRef.current = onStageGit;
  onDocChangeRef.current = onDocChange;
  valueRef.current = value;
  gitOriginalRef.current = gitOriginal;

  const syncChunkNav = useCallback((view: EditorView, fromScroll = true) => {
    const positions = diffNavigablePositions(view);
    const { additions, deletions } = diffLineStatsForView(view);
    if (positions.length === 0) {
      setChunkNav((current) =>
        current && current.positions.length === 0
          ? current
          : {
              positions: [],
              index: 0,
              additions: 0,
              deletions: 0,
            },
      );
      chunkNavPinnedRef.current = null;
      return;
    }
    let index = chunkNavPinnedRef.current;
    if (
      fromScroll ||
      index === null ||
      index < 0 ||
      index >= positions.length
    ) {
      index = diffActiveChunkIndex(view, positions);
    }
    chunkNavPinnedRef.current = index;
    setChunkNav((current) => {
      if (
        current &&
        current.index === index &&
        current.additions === additions &&
        current.deletions === deletions &&
        current.positions.length === positions.length &&
        current.positions.every((pos, i) => pos === positions[i])
      ) {
        return current;
      }
      return { positions, index, additions, deletions };
    });
  }, []);

  const stepChunkNav = useCallback(
    (delta: number) => {
      const view = viewRef.current;
      if (!view || !chunkNav || chunkNav.positions.length === 0) return;
      const next = Math.min(
        chunkNav.positions.length - 1,
        Math.max(0, chunkNav.index + delta),
      );
      if (next === chunkNav.index) return;
      chunkNavPinnedRef.current = next;
      diffScrollToChunk(view, chunkNav.positions[next]);
      setChunkNav({
        positions: chunkNav.positions,
        index: next,
        additions: chunkNav.additions,
        deletions: chunkNav.deletions,
      });
    },
    [chunkNav],
  );

  stepRef.current = stepChunkNav;
  useEffect(() => onChunkNavRef.current(chunkNav), [chunkNav]);
  useEffect(
    () => () => {
      stepRef.current = null;
      onChunkNavRef.current(null);
    },
    [stepRef],
  );

  const setDirty = (nextDirty: boolean) => {
    if (dirtyRef.current === nextDirty) return;
    dirtyRef.current = nextDirty;
    onDirtyChangeRef.current(nextDirty);
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const language = new Compartment();
    let disposed = false;
    let saveGeneration = 0;
    let view: EditorView;

    const markDirty = () => {
      const saved = savedDocumentRef.current;
      setDirty(saved ? !view.state.doc.eq(saved) : false);
    };

    const saveNow = async (): Promise<boolean> => {
      const generation = ++saveGeneration;
      const before = view.state.doc.toString();
      const result = await formatText(
        path,
        before,
        view.state.selection.main.head,
      );
      if (disposed || generation !== saveGeneration) return false;

      if (
        result &&
        result.formatted !== before &&
        view.state.doc.toString() === before
      ) {
        replaceEditorDoc(view, result.formatted, {
          selection: {
            anchor: Math.min(
              Math.max(0, result.cursorOffset),
              result.formatted.length,
            ),
          },
        });
      }

      const document = view.state.doc;
      try {
        await onSaveRef.current(document.toString());
      } catch {
        return false;
      }
      if (disposed || generation !== saveGeneration) return false;
      savedDocumentRef.current = document;
      markDirty();
      return true;
    };
    const save = () => {
      void saveNow();
      return true;
    };

    // Auto save: write 800 ms after the last keystroke when the setting is on.
    let autoSaveTimer: number | null = null;
    const scheduleAutoSave = () => {
      if (autoSaveTimer !== null) window.clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
      if (!loadAutoSave() || !dirtyRef.current) return;
      autoSaveTimer = window.setTimeout(() => {
        autoSaveTimer = null;
        if (!disposed && dirtyRef.current) void saveNow();
      }, 800);
    };
    const unregisterFlusher = registerEditorFlusher(path, async () => {
      if (autoSaveTimer !== null) window.clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
      return dirtyRef.current ? saveNow() : true;
    });

    view = new EditorView({
      doc: valueRef.current,
      parent: host,
      extensions: [
        minimalSetup,
        readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
        showDiff
          ? editorGit(
              onStageGit
                ? {
                    onStage: (contents) => onStageGitRef.current?.(contents),
                  }
                : undefined,
            )
          : [],
        lineNumbers(),
        foldGutter(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        EditorView.lineWrapping,
        wrappedLineIndent,
        language.of([]),
        editorScheme.of(schemeExtensions(isLightScheme() ? "light" : "dark")),
        editorMatching,
        editorTyping(path),
        editorAutocomplete,
        editorLint(path, (count) => onErrorCountChangeRef.current(count)),
        editorSearch,
        Prec.high(
          keymap.of([
            ...foldKeymap,
            { key: "Mod-s", run: save, preventDefault: true },
            {
              key: "Tab",
              run: (view) => {
                if (
                  completionStatus(view.state) === "active" &&
                  acceptCompletion(view)
                ) {
                  return true;
                }
                return tryExpandEmmet(view) || indentOrInsertTab(view);
              },
              shift: indentLess,
              preventDefault: true,
            },
          ]),
        ),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          onDocChangeRef.current?.(update.state.doc.toString());
          if (update.transactions.some((tr) => tr.annotation(diskReload))) {
            return;
          }
          markDirty();
          scheduleAutoSave();
        }),
        showDiff
          ? EditorView.updateListener.of((update) => {
              if (!diffNavUpdateRelevant(update)) return;
              chunkNavPinnedRef.current = null;
              syncChunkNav(update.view);
            })
          : [],
      ],
    });
    savedDocumentRef.current = view.state.doc;
    dirtyRef.current = false;
    viewRef.current = view;
    lockOverscroll(view.scrollDOM as HTMLDivElement);
    if (showDiff) {
      if (gitOriginalRef.current) {
        setGitOriginal(view, gitOriginalRef.current);
      }
      syncChunkNav(view);
    } else {
      setChunkNav({
        positions: [],
        index: 0,
        additions: 0,
        deletions: 0,
      });
    }
    if (activeRef.current) view.focus();

    void languageForPath(path).then((extension) => {
      if (!disposed && extension) {
        view.dispatch({ effects: language.reconfigure(extension) });
      }
    });

    return () => {
      disposed = true;
      if (autoSaveTimer !== null) window.clearTimeout(autoSaveTimer);
      unregisterFlusher();
      onErrorCountChangeRef.current(0);
      lockOverscroll(null);
      viewRef.current = null;
      savedDocumentRef.current = null;
      setChunkNav(null);
      view.destroy();
    };
  }, [lockOverscroll, path, readOnly, showDiff, syncChunkNav]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editorScheme.reconfigure(schemeExtensions(colorScheme)),
    });
  }, [colorScheme]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !showDiff) return;
    let changed = false;
    preserveEditorViewport(view, () => {
      changed = setGitOriginal(view, gitOriginal);
    });
    if (!changed) return;
    chunkNavPinnedRef.current = null;
    syncChunkNav(view);
  }, [gitOriginal, showDiff, syncChunkNav]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !showDiff) return;
    const onScroll = () => {
      chunkNavPinnedRef.current = null;
      syncChunkNav(view);
    };
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    return () => view.scrollDOM.removeEventListener("scroll", onScroll);
  }, [showDiff, syncChunkNav, path]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || dirtyRef.current) return;
    if (view.state.doc.toString() === value) return;
    replaceEditorDoc(view, value, {
      annotations: [Transaction.addToHistory.of(false), diskReload.of(true)],
    });
    savedDocumentRef.current = view.state.doc;
    setDirty(false);
    if (showDiff) {
      chunkNavPinnedRef.current = null;
      syncChunkNav(view);
    }
  }, [showDiff, syncChunkNav, value]);

  useEffect(() => {
    if (!navigation) return;
    const view = viewRef.current;
    if (!view) return;

    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      if (view.state.doc.lines < navigation.line) {
        requestAnimationFrame(run);
        return;
      }
      if (cancelled) return;
      revealNavigation(view, navigation);
    };
    requestAnimationFrame(() => requestAnimationFrame(run));

    return () => {
      cancelled = true;
    };
  }, [navigation]);

  useEffect(() => {
    if (!active) return;
    const view = viewRef.current;
    if (!view) return;
    view.requestMeasure();
    const activeEl = document.activeElement;
    if (
      activeEl &&
      view.dom.contains(activeEl) &&
      activeEl !== view.contentDOM
    ) {
      return;
    }
    view.focus();
  }, [active, path]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div ref={hostRef} className="min-h-0 flex-1" />
    </div>
  );
}

function revealNavigation(view: EditorView, target: EditorNavigation) {
  const lineNumber = Math.min(Math.max(1, target.line), view.state.doc.lines);
  const line = view.state.doc.line(lineNumber);
  const column = Math.max(1, target.column ?? 1);
  const anchor = Math.min(line.from + column - 1, line.to);
  view.dispatch({
    selection: { anchor },
    effects: EditorView.scrollIntoView(anchor, { y: "center" }),
  });
  view.focus();
}

const diskReload = Annotation.define<boolean>();

function indentOrInsertTab(view: EditorView): boolean {
  const { state, dispatch } = view;
  if (state.readOnly) return false;
  if (state.selection.ranges.some((range) => !range.empty)) {
    return indentMore(view);
  }

  const unit = state.facet(indentUnit);
  if (unit === "\t") {
    dispatch(
      state.update(state.replaceSelection("\t"), {
        scrollIntoView: true,
        userEvent: "input",
      }),
    );
    return true;
  }

  const width = getIndentUnit(state);
  dispatch(
    state.update(
      state.changeByRange((range) => {
        const line = state.doc.lineAt(range.head);
        const column = countColumn(
          line.text.slice(0, range.head - line.from),
          state.tabSize,
        );
        const insert = " ".repeat(width - (column % width) || width);
        return {
          changes: { from: range.head, insert },
          range: EditorSelection.cursor(range.head + insert.length),
        };
      }),
      { scrollIntoView: true, userEvent: "input" },
    ),
  );
  return true;
}

type LineRange = { from: number; to: number };

const wrappedLineIndent = StateField.define<DecorationSet>({
  create(state) {
    return Decoration.set(
      indentDecorations(state, [{ from: 0, to: state.doc.length }]),
      true,
    );
  },
  update(decorations, transaction) {
    if (!transaction.docChanged) return decorations;
    const ranges: LineRange[] = [];
    transaction.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      const from = transaction.state.doc.lineAt(fromB).from;
      const to = transaction.state.doc.lineAt(toB).to;
      ranges.push({ from, to });
    });
    const changedLines = mergeLineRanges(ranges);
    return decorations.map(transaction.changes).update({
      filter: (from) =>
        !changedLines.some((range) => from >= range.from && from <= range.to),
      add: indentDecorations(transaction.state, changedLines),
      sort: true,
    });
  },
  provide: (field) => EditorView.decorations.from(field),
});

function indentDecorations(state: EditorState, ranges: LineRange[]) {
  const decorations = [];
  for (const range of ranges) {
    let line = state.doc.lineAt(range.from);
    while (line.from <= range.to) {
      const columns = leadingIndentColumns(line.text, state.tabSize);
      if (columns > 0) {
        const indent = Math.min(columns, 40);
        decorations.push(
          Decoration.line({
            attributes: {
              class: "cm-wrapped-indent",
              style: `padding-left: calc(${indent}ch + 6px); text-indent: -${indent}ch`,
            },
          }).range(line.from),
        );
      }
      if (line.number >= state.doc.lines) break;
      line = state.doc.line(line.number + 1);
    }
  }
  return decorations;
}

function leadingIndentColumns(text: string, tabSize: number): number {
  let columns = 0;
  for (const character of text) {
    if (character === " ") {
      columns += 1;
    } else if (character === "\t") {
      columns += tabSize - (columns % tabSize);
    } else {
      break;
    }
  }
  return columns;
}

function mergeLineRanges(ranges: LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const merged: LineRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.from <= previous.to + 1) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function isMarkdownPath(path: string): boolean {
  const name = basename(path).toLowerCase();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  return [".md", ".mdx", ".markdown"].includes(extension);
}
