import SwiftUI
import TempCodeClient
import TempCodeContract

/// The navigation bar's principal item, the way Messages and Notes title a
/// screen: the thread's title, and under it one quiet line read off
/// `ThreadHeaderLine`: the status mark, the type tinted, the model, and the
/// elapsed ticking in tabular digits while the thread is live. The host
/// leads that line only when more than one is paired, and only when it
/// fits; the line drops the host, then compacts, before the title does.
/// Long-press (or Rename… in the menu) swaps the title for a field in
/// place; Done or losing focus commits.
struct ThreadHeader: View {
    let client: EnvironmentClient
    let session: SessionMeta?
    /// The title to keep showing once the session is gone.
    let fallbackTitle: String?
    /// The host's name when more than one host is paired, else nil.
    let hostName: String?
    @Binding var renaming: Bool
    @Binding var draft: String
    /// The screen runs `client.rename` with the trimmed draft.
    let onCommit: () -> Void
    /// Long-press and the accessibility action; the screen checks `operateBlock` first.
    let onBeginRename: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 1) {
            if renaming {
                InlineTitleField(draft: $draft, original: session?.title ?? "", onCommit: onCommit, onCancel: { renaming = false })
            } else {
                ZStack {
                    Text(title)
                        .font(.headline)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .id(title)
                        .transition(Motion.swap(reduced: reduceMotion))
                }
                .animation(Motion.crossFade, value: title)
                .contentShape(Rectangle())
                // On the title only: inside the field the long-press is the cursor's.
                .onLongPressGesture(minimumDuration: 0.4) { if session != nil { onBeginRename() } }
            }
            if let session {
                Subtitle(client: client, line: ThreadHeaderLine(session: session, hostName: hostName), session: session)
            }
        }
        .frame(maxWidth: .infinity)
        .sensoryFeedback(.impact(weight: .light), trigger: renaming) { was, now in !was && now }
        // One element to read; while renaming the field stays its own, so VoiceOver can edit it.
        .accessibilityElement(children: renaming ? .contain : .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityAction(named: "Rename") { onBeginRename() }
    }

    private var title: String {
        guard let session else { return fallbackTitle ?? "Thread" }
        if session.title.isEmpty { return session.parentId == nil ? "Untitled" : "Subagent" }
        return session.title
    }

    /// The one line under the title. A live line ticks once a second; the
    /// whole row sits inside the timeline so one clock drives it.
    private struct Subtitle: View {
        let client: EnvironmentClient
        let line: ThreadHeaderLine
        let session: SessionMeta

        var body: some View {
            if line.live {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    row(now: context.date)
                }
            } else {
                row(now: .now)
            }
        }

        private func row(now: Date) -> some View {
            HStack(spacing: 5) {
                if line.mark != .empty {
                    HeaderMark(status: session.status, spinning: line.mark == .spinner)
                        .transition(.opacity)
                }
                ViewThatFits(in: .horizontal) {
                    HeaderParts(client: client, session: session, parts: line.parts, now: now)
                    HeaderParts(client: client, session: session, parts: line.withoutHost, now: now)
                    HeaderParts(client: client, session: session, parts: line.compact, now: now)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .animation(Motion.crossFade, value: line.mark)
        }
    }
}

/// The status mark in the subtitle: the kit's `StatusDot`, drawing what
/// `ThreadHeaderLine` decided (the spinner for starting, and for an idle
/// root whose subagents still work; its own mark otherwise). The dot's
/// column scales with the kit's own metric.
struct HeaderMark: View {
    let status: SessionStatus
    let spinning: Bool

    var body: some View {
        StatusDot(status: status, running: spinning)
    }
}

/// The subtitle's parts joined by a middle dot; `.words` is never preceded
/// by one when it leads the line.
private struct HeaderParts: View {
    let client: EnvironmentClient
    let session: SessionMeta
    let parts: [ThreadHeaderLine.Part]
    let now: Date

    var body: some View {
        HStack(spacing: 5) {
            ForEach(Array(parts.enumerated()), id: \.offset) { index, part in
                if index > 0 { Separator() }
                HeaderPartView(client: client, session: session, part: part, now: now)
            }
        }
    }

    /// The middle dot between the subtitle's parts, a step quieter than them.
    private struct Separator: View {
        var body: some View {
            Text("·")
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
    }
}

/// One part of the subtitle. Slot (a): thread 22 replaces the `.host` body
/// with its chip and dot. `.account` is thread 24's chip (AccountChip.swift).
struct HeaderPartView: View {
    let client: EnvironmentClient
    let session: SessionMeta
    let part: ThreadHeaderLine.Part
    let now: Date

    var body: some View {
        switch part {
        case .host(let name):
            Text(name).foregroundStyle(.tertiary)
        case .master:
            Text("Master").foregroundStyle(.tertiary)
        case .type(let type):
            Text(type.label).fontWeight(.medium).foregroundStyle(type.tint)
        case .agent(let agent):
            Text(agent.label)
        case .model(let id):
            Text(ModelName.short(id))
        case .account:
            AccountChip(client: client, session: session)
        case .elapsed(let since):
            let text = TimeFormat.elapsed(since: since, now: now)
            Text(text)
                .numeric(text)
        case .frozen(let ms):
            Text(TimeFormat.duration(ms: ms)).monospacedDigit()
        case .words(let words):
            Text(words)
        }
    }
}

/// The title as a field, in place: focus lands on appear, Done or losing
/// focus commits a trimmed, non-empty, changed draft and anything else reverts.
struct InlineTitleField: View {
    @Binding var draft: String
    let original: String
    let onCommit: () -> Void
    let onCancel: () -> Void
    @FocusState private var focused: Bool
    /// Done and the focus leaving both end the edit; the first one wins.
    @State private var ended = false

    var body: some View {
        TextField("Title", text: $draft)
            .font(.headline)
            .multilineTextAlignment(.center)
            .submitLabel(.done)
            .textInputAutocapitalization(.sentences)
            .focused($focused)
            .onSubmit(commit)
            .onChange(of: focused) { _, now in if !now { commit() } }
            .onAppear { focused = true }
            .frame(maxWidth: .infinity)
            .accessibilityIdentifier("thread-title-field")
    }

    private func commit() {
        guard !ended else { return }
        ended = true
        let title = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if !title.isEmpty, title != original {
            onCommit()
        } else {
            onCancel()
        }
    }
}
