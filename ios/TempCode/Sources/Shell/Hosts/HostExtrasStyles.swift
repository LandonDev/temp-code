import SwiftUI
import TempCodeClient

/// The few pieces the host detail's Activity sections share (Build, Mac
/// bridge, Devices, Sync). None of them is a Design/ concern: each is a
/// grouped-list row part built from the kit's tokens and motion.

/// A command, a path or a log line: mono one step down from the row's title,
/// one line, cut at the tail, selectable.
struct MonoLine: View {
    let text: String
    var truncation: Text.TruncationMode = .tail

    init(_ text: String, truncation: Text.TruncationMode = .tail) {
        self.text = text
        self.truncation = truncation
    }

    var body: some View {
        Text(text)
            .font(.footnote.monospaced())
            .lineLimit(1)
            .truncationMode(truncation)
            .textSelection(.enabled)
    }
}

/// The status column every row of these sections leads with
/// (`Layout.markWidth`): a dot, a spinner or a glyph. A change of `key`
/// cross-fades in the same box on `Motion.crossFade`; nothing moves.
struct MarkColumn<Key: Hashable, Content: View>: View {
    let key: Key
    @ViewBuilder let content: Content

    var body: some View {
        ZStack {
            content
                .id(key)
                .transition(.opacity)
        }
        .frame(width: Layout.markWidth)
        .animation(Motion.crossFade, value: key)
        .accessibilityHidden(true)
    }
}

/// A device's state dot. One view whose fill changes, so a tone change
/// cross-fades in place and nothing re-enters.
struct DeviceDot: View {
    let tone: DeviceState.Tone

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: Layout.dotSize, height: Layout.dotSize)
            .animation(Motion.crossFade, value: tone)
    }

    private var color: Color {
        switch tone {
        case .on: Tint.success
        case .between: Tint.warning
        case .off: Color(.tertiaryLabel)
        }
    }
}

/// What an action under a section's rows refused: footnote in destructive
/// with the circle glyph at the same weight, arriving like a needs-you row
/// and leaving softer after four seconds. Never an alert.
struct RowErrorLine: View {
    @Binding var message: String?
    static let holdSeconds: Double = 4

    var body: some View {
        if let message {
            Label {
                Text(message)
            } icon: {
                Image(systemName: "exclamationmark.circle")
            }
            .font(TextStep.meta.font)
            .foregroundStyle(Tint.destructive)
            .rowAppearTransition()
            .task(id: message) {
                try? await Task.sleep(for: .seconds(Self.holdSeconds))
                guard !Task.isCancelled else { return }
                withAnimation(Motion.rowLeave) { self.message = nil }
            }
        }
    }
}

/// A section footer of one or two lines: the sentences `FooterLines` joined.
struct FooterText: View {
    let lines: [String]

    var body: some View {
        if !lines.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(lines, id: \.self) { Text($0) }
            }
        }
    }
}

/// A row that waits for the host's first answer: a spinner in the mark column and one word.
struct LookingRow: View {
    var body: some View {
        HStack(spacing: Layout.rowGap) {
            MarkColumn(key: 0) { ProgressView().controlSize(.mini) }
            Text("Looking…")
                .foregroundStyle(.secondary)
        }
    }
}
