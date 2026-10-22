import SwiftUI
import TempCodeClient
import TempCodeContract

/// The deploy's log: the last `LogTail.lines` lines in mono, following the
/// tail while the reader is at the bottom and holding still once they scroll
/// up. The header is the card's title and note; the deploy cannot be stopped
/// once the trigger has it, so the note says so and there is no Stop. While
/// the box restarts mid-deploy the note says the log continues when it is
/// back, and the sheet stays. Appends never animate.
struct DeployLogSheet: View {
    let client: EnvironmentClient
    @Environment(\.dismiss) private var dismiss
    @State private var following = true

    var body: some View {
        let extras = client.extras
        let card = extras.deployJob.map {
            HostJobCard.deploy(status: $0, text: extras.log.text, hostName: client.environment.name, linkUp: client.status.transport == .open, deployedVersion: client.status.lastHello?.build?.version)
        }
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                if let note = card?.note {
                    SwapText(note, step: .meta)
                        .padding(.horizontal, Layout.textEdge)
                        .padding(.bottom, 10)
                }
                Hairline()
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            let lines = card?.lines ?? []
                            if lines.isEmpty {
                                Text("Waiting for output…")
                                    .font(.footnote.monospaced())
                                    .foregroundStyle(.tertiary)
                            }
                            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                                Text(line.isEmpty ? " " : line)
                                    .font(.footnote.monospaced())
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            if let ending = card?.ending {
                                Text(ending.text)
                                    .textStep(.meta, tint: ending.failed ? Tint.destructive : nil)
                                    .padding(.top, 12)
                            }
                            Color.clear
                                .frame(height: 1)
                                .id(Self.tail)
                        }
                        .textSelection(.enabled)
                        .padding(.horizontal, Layout.textEdge)
                        .padding(.vertical, 12)
                    }
                    // The first offset only: once the reader scrolls up, an append must not pull them back.
                    .defaultScrollAnchor(.bottom, for: .initialOffset)
                    .onScrollGeometryChange(for: Bool.self) { geometry in
                        geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 8
                    } action: { _, atBottom in
                        following = atBottom
                    }
                    .onChange(of: extras.log.text) {
                        guard following else { return }
                        Motion.withoutAnimation { proxy.scrollTo(Self.tail, anchor: .bottom) }
                    }
                }
            }
            .navigationTitle(card?.title ?? "Deploy")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationCornerRadius(Radius.sheet)
        .presentationDragIndicator(.visible)
        .accessibilityIdentifier("deploy-log")
    }

    private static let tail = "tail"
}
