import Foundation

/// The Diagnostics screen's numbers as it says them (Settings → a long
/// press on the version line): the phone's own measure of a scroll and of
/// typing, against the budgets in docs/IOS-DESIGN.md "Performance".
public enum DiagnosticsText {
    /// Milliseconds: one decimal under ten, whole above ("8.3 ms", "21 ms").
    public static func ms(_ value: Double) -> String {
        "\(number(value)) ms"
    }

    /// Hitch time for each second of scrolling ("3.1 ms per second").
    public static func hitch(_ msPerSecond: Double) -> String {
        "\(number(msPerSecond)) ms per second"
    }

    /// The share of frames that came late ("0.4%"; "None" for none, "No frames" when nothing was recorded).
    public static func late(_ late: Int, of frames: Int) -> String {
        guard frames > 0 else { return "No frames" }
        guard late > 0 else { return "None" }
        let percent = Double(late) / Double(frames) * 100
        return percent < 0.1 ? "Under 0.1%" : "\(number(percent))%"
    }

    /// The screen's rate, and the rate the frames came at when it differs ("120 Hz", "120 Hz, drawing at 60").
    public static func display(maxFramesPerSecond: Int, medianMs: Double?) -> String {
        guard let medianMs, medianMs > 0 else { return "\(maxFramesPerSecond) Hz" }
        let drawn = Int((1_000 / medianMs).rounded())
        return abs(drawn - maxFramesPerSecond) <= maxFramesPerSecond / 10 ? "\(maxFramesPerSecond) Hz" : "\(maxFramesPerSecond) Hz, drawing at \(drawn)"
    }

    private static func number(_ value: Double) -> String {
        value < 10 ? String(format: "%.1f", value) : String(Int(value.rounded()))
    }
}
