import SwiftUI
import TempCodeClient
import TempCodeContract

/// The console under the running (or failed, until hidden) step: its
/// progress as a count, a label and a 2 pt bar, then its newest lines in
/// mono, one step down, in a field that grows with them up to 220 pt and
/// then scrolls inside. It follows the tail while the person is at the
/// bottom and stops once they scroll up; a line arriving never animates.
struct StepConsole: View {
    let step: BatchSteps.LiveStep
    @State private var follow = true

    var body: some View {
        let lines = BatchSteps.tail(step.log)
        let failed = step.status == .failed
        VStack(alignment: .leading, spacing: 6) {
            if let progress = BatchSteps.progress(step) {
                HStack(spacing: 6) {
                    CountText(progress.count, step: .meta)
                    if let label = progress.label {
                        Text(label)
                            .textStep(.meta)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
                if let fraction = progress.fraction {
                    GeometryReader { geometry in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color(.quaternarySystemFill))
                            Capsule()
                                .fill(failed ? Tint.destructive : Color(.secondaryLabel))
                                .frame(width: geometry.size.width * fraction)
                        }
                    }
                    .frame(height: 2)
                    .animation(.linear(duration: 0.2), value: fraction)
                    .accessibilityLabel("\(Int((fraction * 100).rounded())) percent")
                }
            }
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        if lines.isEmpty {
                            Text(failed ? "No output" : "Starting…")
                                .foregroundStyle(.tertiary)
                        } else {
                            Text(lines.joined(separator: "\n"))
                                .transaction { $0.animation = nil }
                        }
                        if failed, !step.detail.isEmpty {
                            Text(step.detail)
                                .foregroundStyle(Tint.destructive)
                                .padding(.top, 4)
                        }
                        Color.clear
                            .frame(height: 1)
                            .id("tail")
                    }
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(MasterLayout.consolePadding)
                }
                .frame(minHeight: MasterLayout.consoleMinHeight, maxHeight: MasterLayout.consoleMaxHeight)
                .background(Surface.chrome, in: RoundedRectangle.fieldCorner)
                .onScrollGeometryChange(for: Bool.self) { geometry in
                    geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 8
                } action: { _, atBottom in
                    follow = atBottom
                }
                .onChange(of: BatchSteps.logKey(step.log)) {
                    if follow { Motion.withoutAnimation { proxy.scrollTo("tail", anchor: .bottom) } }
                }
                .onChange(of: step.id) {
                    follow = true
                    Motion.withoutAnimation { proxy.scrollTo("tail", anchor: .bottom) }
                }
                .onAppear {
                    Motion.withoutAnimation { proxy.scrollTo("tail", anchor: .bottom) }
                }
            }
        }
        .padding(.leading, MasterLayout.stepInset)
        .padding(.trailing, Layout.textEdge)
        .padding(.bottom, 8)
        .accessibilityIdentifier("step-console")
    }
}
