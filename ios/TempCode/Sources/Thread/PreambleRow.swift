import SwiftUI
import TempCodeClient
import TempCodeContract

/// The project rules a thread's first message opened with, folded to one
/// line above the brief: "Project rules · 212 words". Tap opens the text in
/// place with a 150 ms cross-fade. A record, not an editor.
struct PreambleRow: View {
    let stamp: PreambleStamp
    @State private var open = false
    @Environment(\.displayScale) private var scale

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(Motion.crossFade) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(open ? 90 : 0))
                    Text("Project rules")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Text("· \(stamp.words) \(stamp.words == 1 ? "word" : "words")")
                        .font(.footnote)
                        .foregroundStyle(.tertiary)
                        .monospacedDigit()
                }
                .frame(minHeight: 28)
                .contentShape(Rectangle())
            }
            .buttonStyle(.pressable)
            .accessibilityLabel("Project rules, \(stamp.words) \(stamp.words == 1 ? "word" : "words")")
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            if open {
                Text(stamp.text)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .padding(.leading, 10)
                    .overlay(alignment: .leading) { Rectangle().fill(Surface.hairline).frame(width: 1 / scale) }
                    .transition(.opacity)
            }
        }
    }
}
