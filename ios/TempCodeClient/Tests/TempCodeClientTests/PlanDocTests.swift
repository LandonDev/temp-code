import Foundation
import Testing
@testable import TempCodeClient

private let plan = """
# Ship it

Intro line.

## Overview
Some words.

## Tasks
- [x] First thing
- [ ] Second thing
1. Third thing

```
# not a heading
```

### Risks
- none

"""

@Suite struct PlanDocTests {
    @Test func `splits on headings outside fences and keeps the preamble`() {
        let sections = PlanDoc.sections(plan)
        #expect(sections.map { [$0.heading ?? "", String($0.level)] } == [["Ship it", "1"], ["Overview", "2"], ["Tasks", "2"], ["Risks", "3"]])
        #expect(sections[2].body.contains("# not a heading"))
        #expect(PlanDoc.sections("just text\n")[0].heading == nil)
        #expect(PlanDoc.sections("").isEmpty)
    }

    @Test func `reads the task checklist under the tasks heading`() {
        #expect(PlanDoc.tasks(PlanDoc.sections(plan)) == ["First thing", "Second thing", "Third thing"])
        #expect(PlanDoc.tasks(PlanDoc.sections("# A\n\n## Notes\n- b\n")).isEmpty)
    }

    @Test func `counts ticks and finds the title`() {
        let progress = PlanDoc.progress(plan)
        #expect(progress.done == 1 && progress.total == 2)
        #expect(PlanDoc.heading(plan) == "Ship it")
        #expect(PlanDoc.heading("no title") == nil)
    }

    @Test func `parses report frontmatter and falls back to the H1`() {
        let report = PlanDoc.report("---\ntitle: \"Bun and SQLite\"\nstatus: in-progress\nsummary: early notes\n---\n# Body\ntext\n")
        #expect(report == Report(title: "Bun and SQLite", status: "in-progress", summary: "early notes", body: "# Body\ntext\n"))
        #expect(!report.isComplete)
        let bare = PlanDoc.report("# Only heading\n\nbody")
        #expect(bare.title == "Only heading")
        #expect(bare.status == nil)
        #expect(bare.body == "# Only heading\n\nbody")
        #expect(PlanDoc.report("---\nstatus: complete\n---\n").isComplete)
    }
}
