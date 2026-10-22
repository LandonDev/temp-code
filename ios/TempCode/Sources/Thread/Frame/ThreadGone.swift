import SwiftUI

/// What a thread leaves behind when it was moved or deleted while open:
/// one quiet line where the body was, the way compaction and system rows
/// read in the transcript. Nothing else on the screen can act any more.
struct GoneLine: View {
    let reason: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack {
            HStack(spacing: 8) {
                Image(systemName: "minus.circle")
                Text(reason)
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.horizontal, Layout.textEdge)
            .padding(.top, 40)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
        .transition(Motion.appear(reduced: reduceMotion))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("thread-gone")
    }
}
