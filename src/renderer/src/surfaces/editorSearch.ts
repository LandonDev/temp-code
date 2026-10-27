import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  highlightSelectionMatches,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  SearchQuery,
  searchPanelOpen,
  setSearchQuery,
} from "@codemirror/search";
import {
  EditorSelection,
  Prec,
  type Extension,
  type SelectionRange,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  runScopeHandlers,
  type KeyBinding,
  type Panel,
  type ViewUpdate,
} from "@codemirror/view";
import { createElement, createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import {
  countLabel,
  FindBar,
  type FindBarState,
  type FindFlag,
} from "./FindBar";

const MATCH_CAP = 999;
const panels = new WeakMap<EditorView, FindPanel>();

export function handleEditorFindKey(event: KeyboardEvent): boolean {
  if (event.isComposing) return false;

  const target = event.target instanceof Element ? event.target : null;
  if (
    target?.closest(
      "[data-file-picker], [data-symbol-picker], [data-model-picker], [data-branch-picker], [data-command-popover]",
    )
  ) {
    return false;
  }

  const view = editorViewForFind();
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();

  if (mod && event.altKey && !event.shiftKey && key === "f") {
    if (!view) return false;
    event.preventDefault();
    openReplacePanel(view);
    return true;
  }

  if (mod && !event.altKey && !event.shiftKey && key === "f") {
    if (!view) return false;
    event.preventDefault();
    openSearchPanel(view);
    return true;
  }

  if (event.key === "F3" || (mod && !event.altKey && key === "g")) {
    if (!view) return false;
    event.preventDefault();
    (event.shiftKey ? findPrevious : findNext)(view);
    return true;
  }

  if (event.key === "Escape") {
    if (!view || !searchPanelOpen(view.state)) return false;
    event.preventDefault();
    closeSearchPanel(view);
    return true;
  }

  return false;
}

function isUsableEditorElement(node: Element): boolean {
  if (!(node instanceof HTMLElement)) return false;
  return !isHiddenEditorHost(node);
}

export function isHiddenEditorHost(node: {
  closest: (selector: string) => unknown;
  checkVisibility?: () => boolean;
}): boolean {
  if (node.closest(".hidden, .invisible, [hidden], [aria-hidden='true']")) {
    return true;
  }
  if (typeof node.checkVisibility === "function" && !node.checkVisibility()) {
    return true;
  }
  return false;
}

function editorElementForFind(): HTMLElement | null {
  if (monacoHasFocus()) return null;
  const focused = focusedEditorElement();
  if (focused && isUsableEditorElement(focused)) return focused;
  for (const node of document.querySelectorAll(".cm-editor")) {
    if (node instanceof HTMLElement && isUsableEditorElement(node)) return node;
  }
  return null;
}

/** Focus inside a Monaco editor: Monaco's own find owns the keys. */
function monacoHasFocus(): boolean {
  const active = document.activeElement;
  return active instanceof Element && Boolean(active.closest(".monaco-editor"));
}

function focusedEditorElement(): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof Element) {
    const fromActive = active.closest(".cm-editor");
    if (fromActive instanceof HTMLElement) return fromActive;
  }
  const focused = document.querySelector(".cm-editor.cm-focused");
  return focused instanceof HTMLElement ? focused : null;
}

function editorViewForFind(): EditorView | null {
  const el = editorElementForFind();
  return el ? EditorView.findFromDOM(el) : null;
}

export function openFindInActiveEditor(): boolean {
  const view = editorViewForFind();
  if (!view) return false;
  openSearchPanel(view);
  return true;
}

function openReplacePanel(view: EditorView): boolean {
  openSearchPanel(view);
  panels.get(view)?.setReplaceVisible(true, true);
  return true;
}

function findKeymap(): KeyBinding[] {
  return [
    {
      key: "Mod-f",
      run: openSearchPanel,
      scope: "editor search-panel",
      preventDefault: true,
    },
    {
      key: "Mod-Alt-f",
      run: openReplacePanel,
      scope: "editor search-panel",
      preventDefault: true,
    },
    {
      key: "F3",
      run: findNext,
      shift: findPrevious,
      scope: "editor search-panel",
      preventDefault: true,
    },
    {
      key: "Mod-g",
      run: findNext,
      shift: findPrevious,
      scope: "editor search-panel",
      preventDefault: true,
    },
    {
      key: "Escape",
      run: closeSearchPanel,
      scope: "editor search-panel",
    },
  ];
}

/**
 * CodeMirror's search panel, drawn by FindBar through a React root on the
 * panel's node. The search itself stays CodeMirror's.
 */
class FindPanel implements Panel {
  readonly view: EditorView;
  readonly dom: HTMLElement;
  readonly top = true;
  query: SearchQuery;
  private state: FindBarState;
  private composing = false;
  private readonly root: Root;
  private readonly searchRef = createRef<HTMLInputElement>();
  private readonly replaceRef = createRef<HTMLInputElement>();

  constructor(view: EditorView) {
    this.view = view;
    this.query = getSearchQuery(view.state);
    panels.set(view, this);
    this.state = {
      search: this.query.search,
      replace: this.query.replace,
      caseSensitive: this.query.caseSensitive,
      wholeWord: this.query.wholeWord,
      regexp: this.query.regexp,
      replaceVisible: false,
      count: { text: "", state: "idle" },
    };
    this.dom = document.createElement("div");
    this.root = createRoot(this.dom);
    this.state.count = this.countOf(this.state.search);
    // openSearchPanel focuses [main-field] the moment the panel mounts, so
    // the field has to exist when the constructor returns.
    flushSync(() => this.render());
  }

  mount() {
    this.searchRef.current?.select();
    this.reveal();
    this.syncCount();
  }

  destroy() {
    panels.delete(this.view);
    // Unmounting inside CodeMirror's update would warn; the node is gone anyway.
    queueMicrotask(() => this.root.unmount());
  }

  update(update: ViewUpdate) {
    let changed = false;
    for (const transaction of update.transactions) {
      for (const effect of transaction.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.query = effect.value;
          this.state = {
            ...this.state,
            search: this.query.search,
            replace: this.query.replace,
            caseSensitive: this.query.caseSensitive,
            wholeWord: this.query.wholeWord,
            regexp: this.query.regexp,
          };
          changed = true;
        }
      }
    }
    if (
      changed ||
      update.docChanged ||
      update.selectionSet ||
      update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(setSearchQuery)),
      )
    ) {
      this.syncCount();
    }
  }

  setReplaceVisible(visible: boolean, focusReplace = false) {
    this.state = { ...this.state, replaceVisible: visible };
    flushSync(() => this.render());
    if (visible && focusReplace) {
      this.replaceRef.current?.focus();
      this.replaceRef.current?.select();
    }
  }

  private render() {
    this.root.render(
      createElement(FindBar, {
        ...this.state,
        searchRef: this.searchRef,
        replaceRef: this.replaceRef,
        onSearch: (value) => {
          this.state = { ...this.state, search: value };
          if (this.composing) this.render();
          else this.commit(true);
        },
        onReplace: (value) => {
          this.state = { ...this.state, replace: value };
          this.commit(false);
        },
        onToggle: (flag) => this.toggle(flag),
        onToggleReplace: () =>
          this.setReplaceVisible(
            !this.state.replaceVisible,
            this.state.replaceVisible,
          ),
        onPrev: () => findPrevious(this.view),
        onNext: () => findNext(this.view),
        onClose: () => closeSearchPanel(this.view),
        onReplaceNext: () => replaceNext(this.view),
        onReplaceAll: () => replaceAll(this.view),
        onKeyDown: (event) => this.onKeyDown(event),
        onCompositionStart: () => {
          this.composing = true;
        },
        onCompositionEnd: () => {
          this.composing = false;
          this.commit(true);
        },
      }),
    );
  }

  private toggle(flag: FindFlag) {
    this.state = { ...this.state, [flag]: !this.state[flag] };
    this.query = this.queryOf();
    this.view.dispatch({ effects: setSearchQuery.of(this.query) });
    this.reveal();
    this.syncCount();
  }

  private queryOf(): SearchQuery {
    return new SearchQuery({
      search: this.state.search,
      replace: this.state.replace,
      caseSensitive: this.state.caseSensitive,
      wholeWord: this.state.wholeWord,
      regexp: this.state.regexp,
      literal: true,
    });
  }

  private commit(reveal: boolean) {
    const query = this.queryOf();
    if (!query.eq(this.query)) {
      this.query = query;
      this.view.dispatch({ effects: setSearchQuery.of(query) });
    }
    if (reveal) this.reveal();
    this.syncCount();
  }

  private reveal() {
    if (this.view.root.activeElement === this.view.contentDOM) return;
    const query = getSearchQuery(this.view.state);
    if (!query.valid) return;
    const selection = this.view.state.selection.main;
    const forward = query.getCursor(this.view.state, selection.from);
    let match = nextMatch(forward);
    if (!match) {
      match = nextMatch(query.getCursor(this.view.state, 0, selection.from));
    }
    if (!match) return;
    if (selection.from === match.from && selection.to === match.to) return;
    const range = EditorSelection.single(match.from, match.to);
    this.view.dispatch({
      selection: range,
      effects: scrollToSearchMatch(range.main, this.view),
      userEvent: "select.search",
    });
  }

  private countOf(value: string) {
    if (!value || !this.query.valid) {
      return countLabel({ value, valid: this.query.valid, current: 0, total: 0, capped: false });
    }
    return countLabel({ value, valid: true, ...countMatches(this.view) });
  }

  private syncCount() {
    this.state = { ...this.state, count: this.countOf(this.state.search) };
    this.render();
  }

  private onKeyDown(event: KeyboardEvent) {
    if (runScopeHandlers(this.view, event, "search-panel")) {
      event.preventDefault();
      return;
    }
    if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      const flag: FindFlag | null =
        event.code === "KeyC"
          ? "caseSensitive"
          : event.code === "KeyW"
            ? "wholeWord"
            : event.code === "KeyR"
              ? "regexp"
              : null;
      if (flag) {
        event.preventDefault();
        this.toggle(flag);
        return;
      }
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (event.target === this.replaceRef.current) {
      replaceNext(this.view);
      return;
    }
    (event.shiftKey ? findPrevious : findNext)(this.view);
  }
}

function countMatches(view: EditorView): {
  current: number;
  total: number;
  capped: boolean;
} {
  const query = getSearchQuery(view.state);
  if (!query.valid) return { current: 0, total: 0, capped: false };
  const selection = view.state.selection.main;
  const cursor = query.getCursor(view.state);
  let total = 0;
  let current = 0;
  for (let match = nextMatch(cursor); match; match = nextMatch(cursor)) {
    total += 1;
    if (match.from === selection.from && match.to === selection.to) {
      current = total;
    }
    if (total >= MATCH_CAP) return { current, total, capped: true };
  }
  return { current, total, capped: false };
}

function nextMatch(
  cursor: Iterator<{ from: number; to: number }>,
): { from: number; to: number } | null {
  const result = cursor.next();
  return result.done ? null : result.value;
}

const tint = (token: string, percent: number) =>
  `color-mix(in srgb, var(${token}) ${percent}%, transparent)`;

/** The panel's place over the editor and the match marks; FindBar draws
 *  the rest. */
const findTheme = EditorView.theme({
  "&": {
    position: "relative",
  },
  ".cm-panels.cm-panels-top": {
    position: "absolute",
    top: "8px",
    right: "12px",
    left: "auto",
    width: "auto",
    maxWidth: "calc(100% - 24px)",
    zIndex: "40",
    backgroundColor: "transparent",
    border: "none",
    pointerEvents: "auto",
  },
  ".cm-searchMatch": {
    backgroundColor: tint("--color-foreground", 16),
  },
  ".cm-searchMatch-selected": {
    backgroundColor: tint("--color-accent", 40),
  },
  ".cm-selectionMatch": {
    backgroundColor: tint("--color-foreground", 8),
  },
});

function scrollToSearchMatch(range: SelectionRange, view: EditorView) {
  const coords = view.coordsAtPos(range.from);
  const scroller = view.scrollDOM;
  if (coords) {
    const rect = scroller.getBoundingClientRect();
    if (coords.top >= rect.top && coords.bottom <= rect.bottom) {
      return EditorView.scrollIntoView(range, { y: "nearest", yMargin: 24 });
    }
  }
  return EditorView.scrollIntoView(range, { y: "center" });
}

export const editorSearch: Extension = [
  search({
    top: true,
    literal: true,
    createPanel: (view) => new FindPanel(view),
    scrollToMatch: scrollToSearchMatch,
  }),
  highlightSelectionMatches(),
  Prec.high(keymap.of(findKeymap())),
  findTheme,
];
