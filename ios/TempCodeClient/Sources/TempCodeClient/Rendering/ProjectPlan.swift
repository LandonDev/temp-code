import Foundation
import TempCodeContract

/// The project plan as the phone reads it (the desktop's
/// src/shared/projectPlan.ts, line for line): one file per project at
/// `<cwd>/.temp-code/plans/project.md` with fixed sections and the
/// milestones as `### [x] N. Title` headings under `## Milestones`, each
/// with its Scope, Dependencies and Done-when fields. Pure: the phone never
/// writes the file (the host ticks over `projectPlan.tick`), so the two
/// writers of the TypeScript are not here.
public enum ProjectPlan {
    public static let sections = ["Goals", "Current state", "Milestones", "Risks", "Open questions"]
    public static let relativePath = ".temp-code/plans/project.md"

    /// `<cwd>/.temp-code/plans/project.md`, trailing slashes of the cwd dropped.
    public static func path(for cwd: String) -> String {
        var base = Substring(cwd)
        while base.hasSuffix("/") { base = base.dropLast() }
        return String(base) + "/" + relativePath
    }

    public static func isPlanPath(_ path: String?) -> Bool {
        path?.hasSuffix("/" + relativePath) ?? false
    }

    /// A project plan never starts a build on its own, whatever the
    /// auto-implement setting says; an ordinary plan may.
    public static func mayAutoStart(_ threadType: ThreadType?) -> Bool {
        threadType == .planning
    }

    public enum Status: String, Sendable, Hashable {
        case inProgress = "in-progress"
        case complete
    }

    public struct Milestone: Sendable, Hashable, Identifiable {
        /// 1-based: the heading's own number when it has one, else its position.
        public var index: Int
        public var title: String
        public var done: Bool
        public var scope: String?
        public var dependencies: String?
        public var doneWhen: String?
        /// Everything under the heading, verbatim, trailing whitespace trimmed.
        public var body: String
        /// 0-based line of the `###` heading in the whole file, frontmatter included.
        public var line: Int

        /// The heading's line: unique even when two headings share a number.
        public var id: Int { line }

        public init(index: Int, title: String, done: Bool, scope: String? = nil, dependencies: String? = nil, doneWhen: String? = nil, body: String = "", line: Int = 0) {
            self.index = index
            self.title = title
            self.done = done
            self.scope = scope
            self.dependencies = dependencies
            self.doneWhen = doneWhen
            self.body = body
            self.line = line
        }

        /// Whether the row has anything to expand: a field beyond the title.
        public var hasDetails: Bool {
            scope != nil || doneWhen != nil || !ProjectPlan.dependencyChips(dependencies).isEmpty
        }
    }

    public struct Document: Sendable, Hashable {
        public var title: String?
        public var status: Status?
        public var completedAt: String?
        /// `## heading` → its body as written.
        public var sections: [String: String]
        /// The headings in document order (a repeated heading keeps its first place).
        public var sectionOrder: [String]
        /// The fixed sections the document lacks, case-insensitive, in the fixed order.
        public var missing: [String]
        public var milestones: [Milestone]

        public init(title: String? = nil, status: Status? = nil, completedAt: String? = nil, sections: [String: String] = [:], sectionOrder: [String] = [], missing: [String] = ProjectPlan.sections, milestones: [Milestone] = []) {
            self.title = title
            self.status = status
            self.completedAt = completedAt
            self.sections = sections
            self.sectionOrder = sectionOrder
            self.missing = missing
            self.milestones = milestones
        }

        /// The thread said so (plan_complete): the options card and the chip read nothing else.
        public var isComplete: Bool { status == .complete }

        public var progress: (done: Int, total: Int) {
            (milestones.filter(\.done).count, milestones.count)
        }

        /// The first milestone not ticked, in document order.
        public var next: Milestone? { milestones.first { !$0.done } }
    }

    // MARK: - parsing

    // Compiled once and only read: never mutated after the first use.
    nonisolated(unsafe) private static let h1 = #/\#\s+(.+?)\s*/#
    nonisolated(unsafe) private static let h2 = #/\#\#\s+(.+?)\s*/#
    nonisolated(unsafe) private static let milestoneHeading = #/\#\#\#\s+(?:\[([ xX])\]\s+)?(?:(\d+)[.)]\s+)?(.+?)\s*/#
    nonisolated(unsafe) private static let frontmatterField = #/([A-Za-z_][\w-]*):\s*(.*)/#
    nonisolated(unsafe) private static let scopeField = #/\s*(?:[-*]\s*)?(?:\*\*)?(?:Scope)(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*)/#.ignoresCase()
    nonisolated(unsafe) private static let dependenciesField = #/\s*(?:[-*]\s*)?(?:\*\*)?(?:Dependencies|Depends on)(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*)/#.ignoresCase()
    nonisolated(unsafe) private static let doneWhenField = #/\s*(?:[-*]\s*)?(?:\*\*)?(?:Done when|Done-when)(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*)/#.ignoresCase()

    /// The TypeScript's `/^---\n([\s\S]*?)\n---\n?/`: the file starts with
    /// `---`, the fields run to the first `\n---`, and an optional newline
    /// after it is consumed. Returns the fields and the rest of the text.
    static func frontmatter(of md: String) -> (fields: [String: String], rest: Substring) {
        guard md.hasPrefix("---\n") else { return ([:], Substring(md)) }
        let afterOpen = md.index(md.startIndex, offsetBy: 4)
        guard let close = md[afterOpen...].range(of: "\n---") else { return ([:], Substring(md)) }
        var fields: [String: String] = [:]
        for line in md[afterOpen..<close.lowerBound].split(omittingEmptySubsequences: false, whereSeparator: Self.isLineBreak) {
            if let m = line.wholeMatch(of: frontmatterField) {
                fields[String(m.output.1)] = m.output.2.trimmingCharacters(in: .whitespaces)
            }
        }
        var restStart = close.upperBound
        if restStart < md.endIndex, md[restStart] == "\n" { restStart = md.index(after: restStart) }
        return (fields, md[restStart...])
    }

    /// A Swift `Character` holds `\r\n` as one grapheme, so a CRLF file splits here too.
    private static func isLineBreak(_ c: Character) -> Bool { c == "\n" || c == "\r\n" }

    /// The first line of `body` that names the field, its value trimmed; nil when absent or empty.
    private static func field(_ lines: ArraySlice<Substring>, _ regex: Regex<(Substring, Substring)>) -> String? {
        for line in lines {
            guard let m = line.wholeMatch(of: regex) else { continue }
            let value = m.output.1.trimmingCharacters(in: .whitespaces)
            return value.isEmpty ? nil : value
        }
        return nil
    }

    private static func trimmedTail(_ lines: ArraySlice<Substring>) -> String {
        var text = lines.joined(separator: "\n")
        while let last = text.last, last.isWhitespace { text.removeLast() }
        return text
    }

    public static func parse(_ md: String) -> Document {
        let (fields, rest) = frontmatter(of: md)
        let lines = rest.split(omittingEmptySubsequences: false, whereSeparator: Self.isLineBreak)
        let offset = md[..<rest.startIndex].filter(Self.isLineBreak).count
        var title: String?
        var sections: [String: String] = [:]
        var order: [String] = []
        var milestones: [Milestone] = []
        var current: String?
        var sectionStart = -1
        var milestone: (heading: Milestone, start: Int)?
        var inFence = false

        func closeMilestone(_ end: Int) {
            guard let open = milestone else { return }
            let body = lines[open.start..<end]
            var m = open.heading
            m.body = trimmedTail(body)
            m.scope = field(body, scopeField)
            m.dependencies = field(body, dependenciesField)
            m.doneWhen = field(body, doneWhenField)
            milestones.append(m)
            milestone = nil
        }
        func closeSection(_ end: Int) {
            closeMilestone(end)
            if let current {
                if sections[current] == nil { order.append(current) }
                sections[current] = trimmedTail(lines[sectionStart..<end])
            }
            current = nil
        }

        for (i, line) in lines.enumerated() {
            if line.hasPrefix("```") { inFence.toggle() }
            if inFence { continue }
            if title == nil, let m = line.wholeMatch(of: h1) {
                title = String(m.output.1)
                continue
            }
            if let m = line.wholeMatch(of: h2) {
                closeSection(i)
                current = String(m.output.1)
                sectionStart = i + 1
                continue
            }
            if let current, current.lowercased() == "milestones", let m = line.wholeMatch(of: milestoneHeading) {
                closeMilestone(i)
                let index = m.output.2.flatMap { Int($0) } ?? (milestones.count + 1)
                let done = (m.output.1 ?? " ").lowercased() == "x"
                milestone = (Milestone(index: index, title: String(m.output.3), done: done, line: i + offset), i + 1)
            }
        }
        closeSection(lines.count)

        let have = Set(sections.keys.map { $0.lowercased() })
        let missing = Self.sections.filter { !have.contains($0.lowercased()) }
        let status: Status? = fields["status"] == "complete" ? .complete : fields["status"] == "in-progress" ? .inProgress : nil
        return Document(title: title, status: status, completedAt: fields["completed"], sections: sections, sectionOrder: order, missing: missing, milestones: milestones)
    }

    public static func progress(_ md: String) -> (done: Int, total: Int) {
        parse(md).progress
    }

    public static func next(in md: String) -> Milestone? {
        parse(md).next
    }

    public static func milestone(_ index: Int, in md: String) -> Milestone? {
        parse(md).milestones.first { $0.index == index }
    }

    /// A plan counts as done when the thread said so; nil or anything else is not.
    public static func isComplete(_ md: String?) -> Bool {
        guard let md else { return false }
        return parse(md).isComplete
    }

    /// The summary line the project header shows for a kept plan.
    public static func summary(_ md: String?) -> String? {
        guard let md else { return nil }
        let (done, total) = progress(md)
        if total == 0 { return "Plan" }
        return "\(done) of \(total) milestone\(total == 1 ? "" : "s") done"
    }

    /// The Home chip's text beside its flag: "Plan" until the plan is kept
    /// and has milestones, then the count alone, "3/7".
    public static func chipText(done: Int, total: Int, pinned: Bool) -> String {
        guard pinned, total > 0 else { return "Plan" }
        return "\(done)/\(total)"
    }

    /// The dependency field as chips: "1, 2" and "milestone 1 and 2" are
    /// ["1", "2"]; none, a dash or nothing is no chip at all.
    public static func dependencyChips(_ text: String?) -> [String] {
        guard let text else { return [] }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || ["none", "—", "-"].contains(trimmed.lowercased()) { return [] }
        return trimmed
            .replacingOccurrences(of: " and ", with: ",", options: .caseInsensitive)
            .split(separator: ",")
            .map { part -> String in
                var chip = part.trimmingCharacters(in: .whitespaces)
                if chip.lowercased().hasPrefix("milestone ") {
                    chip = String(chip.dropFirst("milestone ".count)).trimmingCharacters(in: .whitespaces)
                }
                return chip
            }
            .filter { !$0.isEmpty }
    }

    // MARK: - briefs

    private static func describe(_ m: Milestone) -> String {
        var parts = ["Milestone \(m.index): \(m.title)"]
        if let scope = m.scope { parts.append("Scope: \(scope)") }
        if let dependencies = m.dependencies { parts.append("Dependencies: \(dependencies)") }
        if let doneWhen = m.doneWhen { parts.append("Done when: \(doneWhen)") }
        return parts.joined(separator: "\n")
    }

    /// The first message of the planning thread "Plan the next milestone" starts.
    public static func planningBrief(planPath: String, milestone m: Milestone) -> String {
        """
        Plan milestone \(m.index) of the project plan at \(planPath): "\(m.title)".

        \(describe(m))

        Read the project plan first — its Goals, Current state and the other milestones are the context — and plan ONLY this milestone: what to build, in what order, with the tasks an implementation thread will work through. Treat the milestone's "Done when" as the plan's finish line. Milestones that depend on this one are out of scope.
        """
    }

    /// The first message of an orchestration thread started for one milestone.
    public static func orchestrationBrief(planPath: String, milestone m: Milestone) -> String {
        """
        Orchestrate milestone \(m.index) of the project plan at \(planPath): "\(m.title)".

        \(describe(m))

        Read the project plan first for the goals and the current state, then split this one milestone across subagents and land it; its "Done when" is the finish line. Other milestones are out of scope.
        """
    }

    /// The title a thread started for a milestone carries: the desktop's
    /// `milestoneThreadTitle` (src/shared/projectPlan.ts), stored by the
    /// host and shown on every host, so it keeps the desktop's form.
    public static func threadTitle(_ m: Milestone) -> String {
        "M\(m.index) · \(m.title)"
    }

    /// "Revise the plan" with nothing typed: the desktop's default turn.
    public static let reviseDefault = "Revise the project plan: re-read the project and the milestone ticks, bring Current state up to date, adjust the remaining milestones, and call plan_complete again when the revision is settled."

    /// The turn "Revise the plan" sends into the plan thread.
    public static func reviseText(_ ask: String) -> String {
        let trimmed = ask.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return reviseDefault }
        return "Revise the project plan: \(trimmed)\n\nKeep the milestone ticks that are there, edit the document in place, and call plan_complete again when the revision is settled."
    }

    /// The optimistic ticks against the document: an entry the document now
    /// agrees with has landed and goes; one for a milestone that is gone goes too.
    public static func reconcile(overlay: [Int: Bool], with milestones: [Milestone]) -> [Int: Bool] {
        var out: [Int: Bool] = [:]
        for (index, done) in overlay {
            guard let m = milestones.first(where: { $0.index == index }), m.done != done else { continue }
            out[index] = done
        }
        return out
    }
}

extension ThreadDraft {
    public enum MilestoneKind: Sendable, Hashable {
        case planning
        case orchestration
    }

    /// "Plan the next milestone" and "Start an orchestration thread for
    /// milestone N" (the desktop's startMilestonePlanning and
    /// startMilestoneOrchestration): the plan thread's project, workspace,
    /// cwd and permission, the catalog choice the sheet made, the milestone's
    /// title and brief; the orchestration carries the plan file and the
    /// milestone's done-when as its goal. The caller links the milestone
    /// over `projectPlan.link` after the create. Nil when the plan thread has
    /// no file or no project.
    public static func milestone(from plan: SessionMeta, milestone: ProjectPlan.Milestone, kind: MilestoneKind, provider: ProviderId, model: String, reasoning: Reasoning?) -> ThreadDraft? {
        guard let planPath = plan.planPath, plan.projectId != nil else { return nil }
        switch kind {
        case .planning:
            return ThreadDraft(
                threadType: .planning,
                provider: provider,
                model: model,
                reasoning: reasoning,
                projectId: plan.projectId,
                workspaceId: plan.workspaceId,
                cwd: plan.cwd,
                permission: plan.permission,
                title: ProjectPlan.threadTitle(milestone),
                brief: ProjectPlan.planningBrief(planPath: planPath, milestone: milestone)
            )
        case .orchestration:
            return ThreadDraft(
                threadType: .orchestration,
                provider: provider,
                model: model,
                reasoning: reasoning,
                projectId: plan.projectId,
                workspaceId: plan.workspaceId,
                cwd: plan.cwd,
                permission: plan.permission,
                planPath: planPath,
                goal: milestone.doneWhen,
                title: ProjectPlan.threadTitle(milestone),
                brief: ProjectPlan.orchestrationBrief(planPath: planPath, milestone: milestone)
            )
        }
    }
}
