import SwiftUI
import TempCodeClient
import UIKit

/// Settings → a long press on the version line. Two checks run on the
/// thread the person last opened, with the drivers the simulator's `perf`
/// proof uses (Sources/Perf): the scroll check moves the transcript at
/// 3,000 pt/s up and back twice, the typing check types 120 characters into
/// its composer and takes them out again. Each pushes that thread, runs, and
/// comes back with what the phone measured; under them is iOS's own scroll
/// hitch measure from MetricKit, when it has sent one. Settings' grammar:
/// an inset grouped list, no glyphs, one sentence of footer.
struct DiagnosticsScreen: View {
    @Environment(AppModel.self) private var model
    @State private var scroll: PerfReport?
    @State private var typing: PerfReport?
    /// The thread pushed for the check that is running.
    @State private var running: ThreadKey?
    @State private var failure: String?
    @State private var shared: URL?
    private let session = PerfSession.shared

    var body: some View {
        let target = session.lastThread
        let title = target.flatMap { key in model.registry.client(key.environmentId)?.session(key.sessionId)?.title }
        let hitch = HitchMetrics.stored
        List {
            Section {
                LabeledContent("Thread") {
                    Text(title ?? "None")
                        .lineLimit(1)
                }
                if let failure {
                    InlineFieldError(message: failure)
                        .rowAppearTransition()
                }
            } footer: {
                Text(title == nil ? "Open a thread, then come back here." : "Both checks run on the thread you last opened.")
            }

            Section {
                Button("Run Scroll Check") { start(.scrollCheck) }
                    .disabled(title == nil)
                if let scroll {
                    LabeledContent("Late Frames", value: DiagnosticsText.late(scroll.late, of: scroll.frames.count))
                    LabeledContent("Longest Frame", value: DiagnosticsText.ms(scroll.frames.worst))
                    LabeledContent("Hitch Time", value: DiagnosticsText.hitch(scroll.hitchMsPerS))
                    LabeledContent("Main Thread", value: DiagnosticsText.ms(scroll.cpuMs.p95))
                }
            } header: {
                Text("Scrolling")
            } footer: {
                Text("Smooth is under 1% late, no frame over 34 ms, under 5 ms of hitches per second and 4 ms of main thread in most frames.")
            }

            Section {
                Button("Run Typing Check") { start(.typingCheck) }
                    .disabled(title == nil)
                if let typing {
                    LabeledContent("Key to Screen", value: DiagnosticsText.ms(typing.keyWallMs.p95))
                    LabeledContent("Slowest Key", value: DiagnosticsText.ms(typing.keyWallMs.worst))
                }
            } header: {
                Text("Typing")
            } footer: {
                Text("Smooth is 17 ms for most keys and 34 ms for the slowest, not counting the keyboard's own delay.")
            }

            Section {
                LabeledContent("Display", value: DiagnosticsText.display(maxFramesPerSecond: screenRate, medianMs: (scroll ?? typing)?.frames.p50))
                LabeledContent("Scroll Hitches", value: hitch.map { DiagnosticsText.hitch($0.msPerSecond) } ?? "No Report Yet")
            } header: {
                Text("From iOS")
            } footer: {
                Text(iosFooter(hitch))
            }

            if let shared {
                Section {
                    ShareLink("Share Report", item: shared)
                }
            }
        }
        .listStyle(.insetGrouped)
        .monospacedDigit()
        .navigationTitle("Diagnostics")
        .navigationBarTitleDisplayMode(.inline)
        .animation(Motion.rowAppear, value: failure)
        .navigationDestination(item: $running) { key in
            if let client = model.registry.client(key.environmentId) {
                ThreadScreen(client: client, sessionId: key.sessionId, performsLaunchAction: false)
            }
        }
        .onChange(of: session.report) { _, report in
            if let report { land(report) }
        }
        .task(id: running) { await giveUp() }
    }

    private var screenRate: Int {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        return scene?.screen.maximumFramesPerSecond ?? 60
    }

    private func iosFooter(_ hitch: HitchMetrics.Stored?) -> String {
        if ProcessInfo.processInfo.isLowPowerModeEnabled { return "Low Power Mode holds the screen to 60 Hz." }
        guard let hitch else { return "iOS measures every scroll in the app and reports at most once a day." }
        return "iOS measured every scroll in the app up to \(hitch.end.formatted(date: .abbreviated, time: .omitted))."
    }

    private func start(_ run: PerfRun) {
        guard let target = session.lastThread else { return }
        failure = nil
        session.ask(run, sessionId: target.sessionId)
        running = target
    }

    private func land(_ report: PerfReport) {
        running = nil
        if let note = report.note {
            failure = "The check did not run: \(note)."
            return
        }
        if report.run == PerfRun.scrollCheck.rawValue { scroll = report } else { typing = report }
        shared = DiagnosticsFile.write(scroll: scroll, typing: typing, hitch: HitchMetrics.stored)
    }

    /// A thread that never opened its transcript (it is gone from its host) takes no check.
    private func giveUp() async {
        guard running != nil else { return }
        try? await Task.sleep(for: .seconds(20))
        guard !Task.isCancelled, session.running == nil, session.request != nil else { return }
        session.cancel()
        running = nil
        failure = "The check did not run: the thread did not open."
    }
}

/// The report Share sends: both checks as they were measured, and the phone they ran on.
enum DiagnosticsFile {
    private struct Report: Codable {
        var app: String
        var device: String
        var system: String
        var scroll: PerfReport?
        var typing: PerfReport?
        var scrollHitch: HitchMetrics.Stored?
    }

    static func write(scroll: PerfReport?, typing: PerfReport?, hitch: HitchMetrics.Stored?) -> URL? {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "0"
        let build = info?["CFBundleVersion"] as? String ?? "0"
        let report = Report(app: "\(version) (\(build))", device: UIDevice.current.model, system: UIDevice.current.systemVersion, scroll: scroll, typing: typing, scrollHitch: hitch)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
        encoder.dateEncodingStrategy = .iso8601
        let url = FileManager.default.temporaryDirectory.appending(path: "TempCode-diagnostics.json")
        guard let data = try? encoder.encode(report), (try? data.write(to: url, options: .atomic)) != nil else { return nil }
        return url
    }
}
