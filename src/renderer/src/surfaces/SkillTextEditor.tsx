import { Annotation, Compartment, EditorState, Transaction, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { minimalSetup } from "codemirror";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useColorScheme } from "../hooks/useColorScheme";
import { languageForPath, schemeExtensions } from "./editorChrome";

/** A change the editor did not take from the person: a new skill's SKILL.md following the Name field. */
const fromOutside = Annotation.define<boolean>();

/** The frame inside the dialog's box: the editor fills it and scrolls both ways in its own native scroller. */
const FRAME = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { overflow: "auto" },
});

/**
 * A CodeMirror buffer over a string, for the skill editor (Settings →
 * Skills): line numbers, the scheme's theme and the path's language, and
 * nothing that touches a disk, git or a linter. Each path keeps its own
 * `EditorState` for the dialog's life, so a file keeps its undo history and
 * an Undo never brings another file's text in. A `value` the document lacks
 * replaces it without an undo step and without `onChange`, which fires only
 * for the person's own edits. It lives in the editor chunk; settings reach it
 * through `editorChunk.surface`.
 */
export function SkillTextEditor({ path, value, onChange, label }: { path: string; value: string; onChange: (text: string) => void; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const shown = useRef<string | null>(null);
  const compartments = useRef<{ theme: Compartment; language: Compartment; attrs: Compartment } | null>(null);
  const onChangeRef = useRef(onChange);
  const scheme = useColorScheme();
  const schemeRef = useRef(scheme);
  useLayoutEffect(() => {
    onChangeRef.current = onChange;
    schemeRef.current = scheme;
  });

  const parts = () => (compartments.current ??= { theme: new Compartment(), language: new Compartment(), attrs: new Compartment() });
  const attrsFor = (name: string): Extension => EditorView.contentAttributes.of({ "aria-label": name });
  const stateFor = (doc: string, name: string): EditorState => {
    const { theme, language, attrs } = parts();
    return EditorState.create({
      doc,
      extensions: [
        minimalSetup,
        lineNumbers(),
        FRAME,
        theme.of(schemeExtensions(schemeRef.current)),
        language.of([]),
        attrs.of(attrsFor(name)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((tr) => tr.annotation(fromOutside))) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });
  };
  /** The path's language, loaded once per state; dropped if the person moved on to another file meanwhile. */
  const loadLanguage = (forPath: string) => {
    void languageForPath(forPath).then((extension) => {
      const v = view.current;
      if (!v || shown.current !== forPath) return;
      v.dispatch({ effects: parts().language.reconfigure(extension ?? []), annotations: [fromOutside.of(true), Transaction.addToHistory.of(false)] });
    });
  };

  // One view for the editor's life, on the first path's state.
  useEffect(() => {
    if (!host.current) return;
    const state = stateFor(value, label);
    states.current.set(path, state);
    shown.current = path;
    view.current = new EditorView({ state, parent: host.current });
    loadLanguage(path);
    return () => {
      view.current?.destroy();
      view.current = null;
    };
    // The first path and value only: later ones arrive through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Another file: keep this one's state, show that one's (made from `value` the first time).
  useEffect(() => {
    const v = view.current;
    if (!v || shown.current === path) return;
    if (shown.current !== null) states.current.set(shown.current, v.state);
    const known = states.current.get(path);
    const next = known ?? stateFor(value, label);
    states.current.set(path, next);
    shown.current = path;
    v.setState(next);
    const { theme, attrs } = parts();
    v.dispatch({
      effects: [theme.reconfigure(schemeExtensions(schemeRef.current)), attrs.reconfigure(attrsFor(label))],
      annotations: [fromOutside.of(true), Transaction.addToHistory.of(false)],
    });
    if (!known) loadLanguage(path);
    // `value` and `label` are this path's own; the value effect follows them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // A value the document lacks, from outside: in place, no undo step, no onChange.
  useEffect(() => {
    const v = view.current;
    if (!v || shown.current !== path) return;
    const doc = v.state.doc.toString();
    if (doc === value) return;
    v.dispatch({ changes: { from: 0, to: doc.length, insert: value }, annotations: [fromOutside.of(true), Transaction.addToHistory.of(false)] });
  }, [value, path]);

  useEffect(() => {
    view.current?.dispatch({ effects: parts().theme.reconfigure(schemeExtensions(scheme)), annotations: [Transaction.addToHistory.of(false)] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheme]);

  return <div ref={host} data-skill-editor className="h-full min-h-0 overflow-hidden rounded-lg border border-border text-xs" />;
}
