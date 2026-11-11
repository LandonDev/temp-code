import Foundation
import MetricKit

/// iOS's own measure of the app's scrolling, kept for the Diagnostics
/// screen: MetricKit delivers a day's metrics at most once a day, on a
/// later launch, so the newest scroll hitch ratio is stored when it comes
/// and read back whenever the screen opens. The subscriber only listens.
final class HitchMetrics: NSObject, MXMetricManagerSubscriber {
    static let shared = HitchMetrics()

    /// Milliseconds of hitch per second of scrolling, over the day that ended at `end`.
    nonisolated struct Stored: Codable, Equatable, Sendable {
        var msPerSecond: Double
        var end: Date
    }

    nonisolated private static let key = "diagnostics.scrollHitch"

    static var stored: Stored? {
        UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(Stored.self, from: $0) }
    }

    func start() {
        MXMetricManager.shared.add(self)
    }

    nonisolated func didReceive(_ payloads: [MXMetricPayload]) {
        let newest = payloads
            .filter { $0.animationMetrics != nil }
            .max { $0.timeStampEnd < $1.timeStampEnd }
        guard let newest, let ratio = newest.animationMetrics?.scrollHitchTimeRatio,
              let data = try? JSONEncoder().encode(Stored(msPerSecond: ratio.value, end: newest.timeStampEnd)) else { return }
        UserDefaults.standard.set(data, forKey: Self.key)
    }
}
