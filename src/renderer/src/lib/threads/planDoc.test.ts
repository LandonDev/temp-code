import { describe, expect, it } from "vitest";
import { parseReport, planHeading, planProgress, planTasks, splitSections } from "./planDoc";

const PLAN = `# Ship it

Intro line.

## Overview
Some words.

## Tasks
- [x] First thing
- [ ] Second thing
1. Third thing

\`\`\`
# not a heading
\`\`\`

### Risks
- none
`;

describe("planDoc", () => {
  it("splits on headings outside fences and keeps the preamble", () => {
    const sections = splitSections(PLAN);
    expect(sections.map((s) => [s.heading, s.level])).toEqual([
      ["Ship it", 1],
      ["Overview", 2],
      ["Tasks", 2],
      ["Risks", 3],
    ]);
    expect(sections[2].body).toContain("# not a heading");
    expect(splitSections("just text\n")[0].heading).toBeNull();
    expect(splitSections("")).toEqual([]);
  });

  it("reads the task checklist under the tasks heading", () => {
    expect(planTasks(splitSections(PLAN))).toEqual(["First thing", "Second thing", "Third thing"]);
    expect(planTasks(splitSections("# A\n\n## Notes\n- b\n"))).toEqual([]);
  });

  it("counts ticks and finds the title", () => {
    expect(planProgress(PLAN)).toEqual({ done: 1, total: 2 });
    expect(planHeading(PLAN)).toBe("Ship it");
    expect(planHeading("no title")).toBeNull();
  });

  it("parses report frontmatter and falls back to the H1", () => {
    const r = parseReport(`---\ntitle: "Bun and SQLite"\nstatus: in-progress\nsummary: early notes\n---\n# Body\ntext\n`);
    expect(r).toEqual({ title: "Bun and SQLite", status: "in-progress", summary: "early notes", body: "# Body\ntext\n" });
    expect(parseReport("# Only heading\n\nbody")).toMatchObject({ title: "Only heading", status: null, body: "# Only heading\n\nbody" });
  });
});
