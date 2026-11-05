import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* The phone writes every duration, curve, font size and row height once:
 * type and lengths in Design/Tokens.swift (over the client package's
 * TranscriptScale), motion in Design/Motion.swift (over MotionValues). A
 * view under Thread, Shell or Design names a token. These counted files are
 * what the tree held when the guard landed (docs/IOS-DESIGN.md "Visual
 * system"); the counts only shrink as each slice retypes its views.
 * IOS_LITERAL_GUARD_PRINT=1 prints the current tally. */
const ROOT = resolve(__dirname, "../ios/TempCode/Sources");
const DIRS = ["Thread", "Shell", "Design"];
const HOME = new Set(["Design/Tokens.swift", "Design/Motion.swift"]);
const ALLOWED: Record<string, number> = {
  "Design/SectionHeader.swift": 1,
  "Shell/FleetSwitches.swift": 1,
  "Shell/HomeStyles.swift": 4,
  "Shell/Hosts/DeployLogSheet.swift": 1,
  "Shell/Hosts/HostActivitySections.swift": 1,
  "Shell/InboxItemView.swift": 2,
  "Shell/InboxStore.swift": 1,
  "Shell/InboxView.swift": 1,
  "Shell/SearchRowViews.swift": 2,
  "Shell/ThreadStrip.swift": 4,
  "Thread/AccountChip.swift": 1,
  "Thread/AccountMenu.swift": 5,
  "Thread/AgentDetailScreen.swift": 2,
  "Thread/BoardOutcomes.swift": 2,
  "Thread/BoardStyles.swift": 1,
  "Thread/ComposerAttachments.swift": 2,
  "Thread/ComposerStyles.swift": 2,
  "Thread/DiffScreen.swift": 1,
  "Thread/DiffStyles.swift": 3,
  "Thread/Frame/ThreadToolbar.swift": 2,
  "Thread/HostChip.swift": 1,
  "Thread/ImplementationBoardView.swift": 1,
  "Thread/Master/BatchFoot.swift": 1,
  "Thread/Master/MasterRows.swift": 5,
  "Thread/Master/MasterView.swift": 3,
  "Thread/Master/StepConsole.swift": 3,
  "Thread/NotesSheet.swift": 1,
  "Thread/PreambleRow.swift": 1,
  "Thread/ResourcesSheet.swift": 2,
  "Thread/SourcesView.swift": 2,
  "Thread/ThreadScreen.swift": 1,
  "Thread/ToolChip.swift": 2,
  "Thread/TranscriptRows.swift": 6,
  "Thread/TranscriptView.swift": 3,
};

// A literal font size, a duration or curve written in place, a fixed row height.
export const LITERAL =
  /\.font\(\.system\(size:|duration:\s*[\d.]|\.timingCurve\(|\.spring\(\s*(?:duration|response|mass|stiffness)|\.easeOut\b|\.easeIn(?:Out)?\b|\.linear\(duration|minHeight:\s*\d|\bheight:\s*\d/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith(".swift")) out.push(path);
  }
  return out;
}

export function literals(text: string): number {
  // Comments describe values; they paint nothing.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return [...code.matchAll(LITERAL)].length;
}

function tally(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const dir of DIRS) {
    for (const path of walk(join(ROOT, dir))) {
      const file = relative(ROOT, path);
      if (HOME.has(file)) continue;
      const count = literals(readFileSync(path, "utf8"));
      if (count) found[file] = count;
    }
  }
  return found;
}

const tree = tally();
if (process.env.IOS_LITERAL_GUARD_PRINT) console.log(JSON.stringify(tree, null, 2));

describe("the phone's literal guard", () => {
  it("finds no literal duration, curve, font size or row height outside the tokens beyond the counted files", () => {
    const problems: string[] = [];
    for (const [file, count] of Object.entries(tree)) {
      const allowed = ALLOWED[file] ?? 0;
      if (count > allowed) problems.push(`${file}: ${count} literals, ${allowed} allowed; name a token in Tokens.swift or Motion.swift`);
    }
    expect(problems).toEqual([]);
  });

  it("keeps the allow-list honest: a count that shrank is lowered", () => {
    const stale = Object.entries(ALLOWED)
      .filter(([file, allowed]) => (tree[file] ?? 0) < allowed)
      .map(([file, allowed]) => `${file}: allowed ${allowed}, found ${tree[file] ?? 0}`);
    expect(stale).toEqual([]);
  });

  it("matches the shapes it exists for and leaves tokens alone", () => {
    expect(literals(".font(.system(size: 13))")).toBe(1);
    expect(literals(".animation(.easeOut(duration: 0.2))")).toBe(2);
    expect(literals(".frame(minHeight: 28)")).toBe(1);
    expect(literals(".timingCurve(0.2, 0, 0, 1, duration: d)")).toBe(1);
    expect(literals(".frame(minHeight: TranscriptMetrics.line).animation(Motion.fast)")).toBe(0);
    expect(literals("// .frame(minHeight: 28)")).toBe(0);
  });
});
