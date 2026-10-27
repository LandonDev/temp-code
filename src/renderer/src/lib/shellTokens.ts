/**
 * A light tint for a command in the transcript's command card: each
 * segment's command, quoted strings, operators and redirects, flags. A
 * small pure scan, not a highlighter: no grammar chunk loads for it.
 */

export type ShellTone = "command" | "string" | "operator" | "flag" | "text";
export type ShellToken = { text: string; tone: ShellTone };

/** Redirects first (`2>&1`, `>>`, `<`), then the separators, longest first. */
const OPERATOR = /\d*>>?(?:&\d+)?|\d*<|&&|\|\||\$\(|[|;&()]/y;
/** Operators after which the next word is a command. */
const SEPARATOR = new Set(["&&", "||", "|", ";", "&", "$(", "("]);
const ENV = /^[A-Za-z_][A-Za-z0-9_]*=/;
const STOP = /[\s|;&<>()'"]/;

export function shellTokens(command: string): ShellToken[] {
  const out: ShellToken[] = [];
  const push = (text: string, tone: ShellTone): void => {
    const prev = out[out.length - 1];
    if (prev && prev.tone === tone && tone === "text") prev.text += text;
    else out.push({ text, tone });
  };
  let expectCommand = true;
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (/\s/.test(c)) {
      let j = i;
      while (j < command.length && /\s/.test(command[j])) j++;
      const space = command.slice(i, j);
      if (space.includes("\n")) expectCommand = true;
      push(space, "text");
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== c) j += c === '"' && command[j] === "\\" ? 2 : 1;
      const end = Math.min(j + 1, command.length);
      push(command.slice(i, end), "string");
      expectCommand = false;
      i = end;
      continue;
    }
    OPERATOR.lastIndex = i;
    const op = OPERATOR.exec(command)?.[0];
    if (op) {
      push(op, "operator");
      if (SEPARATOR.has(op)) expectCommand = true;
      i += op.length;
      continue;
    }
    let j = i + 1;
    while (j < command.length && !STOP.test(command[j]) && !(command[j] === "$" && command[j + 1] === "(")) j++;
    const word = command.slice(i, j);
    if (expectCommand && ENV.test(word)) push(word, "text");
    else if (expectCommand) {
      push(word, "command");
      expectCommand = false;
    } else push(word, word.startsWith("-") ? "flag" : "text");
    i = j;
  }
  return out;
}
