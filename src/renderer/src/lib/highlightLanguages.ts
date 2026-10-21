/**
 * Which grammar the transcript's highlighter (highlight.worker.ts) colours
 * a block with, loaded on first use: shiki ships one chunk per grammar and
 * the worker starts with none, so a transcript of prose and shell never
 * fetches the TypeScript grammar, and the first `ts` block pays for its
 * own chunk once.
 */

/** The languages the transcript colours; anything else is plain text. */
export const LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "bash",
  "python",
  "java",
  "go",
  "rust",
  "html",
  "css",
  "sql",
  "yaml",
  "markdown",
  "diff",
] as const;

export const ALIASES: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  py: "python",
  rs: "rust",
  yml: "yaml",
  md: "markdown",
  golang: "go",
  jsonc: "json",
};

const KNOWN = new Set<string>(LANGS);

/** The grammar name for a fence's `lang`, or null when the transcript does not colour it. */
export function grammarFor(lang: string): string | null {
  const wanted = ALIASES[lang.toLowerCase()] ?? lang.toLowerCase();
  return KNOWN.has(wanted) ? wanted : null;
}

export interface GrammarHost {
  getLoadedLanguages(): string[];
  loadLanguage(grammar: unknown): Promise<void>;
}

/** Loads each grammar once, sharing one in-flight load between concurrent blocks. */
export function createLanguageLoader(
  host: GrammarHost,
  grammars: Record<string, unknown>,
): (lang: string) => Promise<string> {
  const loading = new Map<string, Promise<void>>();
  return async (lang) => {
    const wanted = grammarFor(lang);
    if (!wanted || !(wanted in grammars)) return "text";
    if (host.getLoadedLanguages().includes(wanted)) return wanted;
    let pending = loading.get(wanted);
    if (!pending) {
      pending = host.loadLanguage(grammars[wanted]).finally(() => loading.delete(wanted));
      loading.set(wanted, pending);
    }
    try {
      await pending;
      return wanted;
    } catch {
      // The grammar's chunk did not land (offline /ui, a missing file): plain text, and the next block tries again.
      return "text";
    }
  };
}
