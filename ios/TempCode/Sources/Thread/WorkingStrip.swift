import SwiftUI
import TempCodeClient
import TempCodeContract

/// The desktop's working indicator in its permanently reserved 28 pt row:
/// Sending… bridges a send to the turn's start; then the spinner, a flavour
/// word that turns every seven seconds, and the elapsed time in tabular
/// digits. A paused run fills the row with one warning-tinted line: the
/// glyph, Paused, the frozen elapsed, and Stop and Continue. Only opacity
/// animates, in 120 ms; the row never changes height.
struct WorkingStripView: View {
    let client: EnvironmentClient
    let sessionId: String
    let session: SessionMeta?
    let thread: ThreadState
    @State private var busy = false
    @Environment(\.displayScale) private var scale

    static let height: CGFloat = 28
    static let fade: Animation = .easeOut(duration: 0.12)

    /// The desktop's words, in its order; the seed is the thread's id.
    static let flavourWords = ["Thinking", "Pondering", "Scheming", "Brewing", "Weaving", "Tinkering", "Musing", "Composing", "Sifting", "Untangling", "Distilling", "Sketching", "Plotting", "Riffing", "Combobulating", "Percolating", "Marinating", "Noodling", "Puzzling", "Conjuring"]

    enum Phase: Hashable {
        case idle, sending, working, paused
    }

    /// A waiting thread shows nothing here: its card, the segment dot and
    /// Home's needs-you row already say so, and the row says nothing twice.
    private var phase: Phase {
        switch session?.status {
        case .paused?: return .paused
        case .running?: return .working
        case .starting?: return thread.sending ? .sending : .working
        default: return thread.sending ? .sending : .idle
        }
    }

    var body: some View {
        let phase = phase
        ZStack {
            switch phase {
            case .idle:
                Color.clear
            case .sending:
                line {
                    Text("Sending…")
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                }
            case .working:
                line {
                    ProgressView()
                        .controlSize(.mini)
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let now = context.date.timeIntervalSince1970
                        HStack(spacing: 8) {
                            Text(Self.flavour(seed: sessionId, now: now))
                                .foregroundStyle(.secondary)
                                .contentTransition(.opacity)
                            Text(TimeFormat.elapsed(since: session?.busySince ?? session?.updatedAt ?? 0, now: context.date))
                                .monospacedDigit()
                                .foregroundStyle(.tertiary)
                                .contentTransition(.numericText())
                        }
                        .animation(Motion.crossFade, value: Self.flavour(seed: sessionId, now: now))
                    }
                    Spacer(minLength: 0)
                }
            case .paused:
                pausedRow
            }
        }
        .frame(height: Self.height)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 12)
        .animation(Self.fade, value: phase)
        .accessibilityElement(children: .contain)
    }

    private func line<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: 8, content: content)
            .font(.footnote)
            .padding(.horizontal, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .transition(.opacity)
    }

    /// The warning row at composer width: glyph, Paused, the frozen elapsed, then Stop and Continue.
    private var pausedRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "pause.fill")
                .font(.caption)
                .foregroundStyle(Tint.warning)
            Text("Paused")
                .font(.footnote.weight(.medium))
            Text(TimeFormat.duration(ms: max(0, session?.frozenActiveElapsed ?? 0)))
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Button("Stop") { run { try await client.stop(sessionId) } }
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .buttonStyle(.pressable)
                .frame(minWidth: 44, minHeight: Self.height)
                .contentShape(Rectangle())
            Button {
                run { try await client.resume(sessionId) }
            } label: {
                Text(busy ? "Continuing…" : "Continue")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color(.systemBackground))
                    .padding(.horizontal, 10)
                    .frame(height: 22)
                    .background(Tint.warning, in: Capsule())
            }
            .buttonStyle(.pressable)
            .frame(minHeight: Self.height)
            .contentShape(Rectangle())
        }
        .padding(.horizontal, 10)
        .frame(height: Self.height)
        .background(Tint.warning.opacity(0.1), in: RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.row, style: .continuous).strokeBorder(Tint.warning.opacity(0.2), lineWidth: 1 / scale))
        .disabled(busy || client.operateBlock != nil)
        .opacity(client.operateBlock == nil ? 1 : 0.6)
        .transition(.opacity)
    }

    private func run(_ body: @escaping () async throws -> Void) {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            try? await body()
        }
    }

    /// The word for this second: the desktop's seed over the id, turning every seven seconds.
    static func flavour(seed id: String, now: TimeInterval) -> String {
        var hash: Int32 = 0
        for scalar in id.unicodeScalars { hash = hash &* 31 &+ Int32(truncatingIfNeeded: scalar.value) }
        let seed = Int(abs(hash))
        let turn = Int(now * 1000 / 7000)
        return flavourWords[(seed + turn) % flavourWords.count]
    }
}
