import Foundation
import Testing
@testable import TempCodeClient

/// The desktop's formats (lib/format.ts, lib/contextUsage.ts) as the phone
/// reads them: every branch of `TimeFormat`, the catalog's model names, the
/// compact token count.
private let now = Date(timeIntervalSince1970: 1_800_000_000)

private func ms(secondsAgo: Double) -> Int {
    Int((now.timeIntervalSince1970 - secondsAgo) * 1000)
}

@Suite struct TimeFormatAgoTests {
    @Test(arguments: [
        (0.0, "now"), (59.0, "now"), (60.0, "1m"), (59.0 * 60, "59m"), (3_600.0, "1h"),
        (23.0 * 3_600, "23h"), (24.0 * 3_600, "1d"), (6.0 * 86_400, "6d")
    ])
    func `counts seconds, minutes, hours and days`(secondsAgo: Double, expected: String) {
        #expect(TimeFormat.ago(ms(secondsAgo: secondsAgo), now: now) == expected)
    }

    @Test func `a week back reads as a month and day`() {
        let out = TimeFormat.ago(ms(secondsAgo: 7 * 86_400), now: now)
        #expect(out != "7d")
        #expect(out.contains { $0.isNumber })
        #expect(out.contains { $0.isLetter })
    }

    @Test func `an epoch of zero or less is nothing`() {
        #expect(TimeFormat.ago(0, now: now) == "")
        #expect(TimeFormat.ago(-5, now: now) == "")
    }
}

@Suite struct TimeFormatDurationTests {
    @Test(arguments: [
        (12_000, "12s"), (184_000, "3m 4s"), (7_500_000, "2h 5m"), (97_200_000, "1d 3h"), (-1_000, "0s"), (0, "0s")
    ])
    func `reads seconds, minutes, hours and days`(ms: Int, expected: String) {
        #expect(TimeFormat.duration(ms: ms) == expected)
    }

    @Test func `elapsed is the duration of the difference`() {
        let since = ms(secondsAgo: 184)
        #expect(TimeFormat.elapsed(since: since, now: now) == TimeFormat.duration(ms: 184_000))
        #expect(TimeFormat.elapsed(since: since, now: now) == "3m 4s")
    }
}

@Suite struct TimeFormatStampTests {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        calendar.locale = Locale(identifier: "en_US_POSIX")
        return calendar
    }

    /// 2026-10-22 15:00 UTC, a Thursday.
    private var today: Date {
        calendar.date(from: DateComponents(year: 2026, month: 10, day: 22, hour: 15))!
    }

    private func stamp(_ date: Date) -> String {
        TimeFormat.stamp(Int(date.timeIntervalSince1970 * 1000), now: today, calendar: calendar)
    }

    @Test func `the same day is the time alone`() {
        let out = stamp(calendar.date(byAdding: .hour, value: -6, to: today)!)
        #expect(out.contains("9:00"))
        #expect(!out.contains("Oct"))
        #expect(!out.contains("Thu"))
    }

    @Test func `inside six days leads with the weekday`() {
        let out = stamp(calendar.date(byAdding: .day, value: -3, to: today)!)
        #expect(out.hasPrefix("Mon"))
        #expect(out.contains("3:00"))
        #expect(!out.contains("Oct"))
    }

    @Test func `the same year leads with the month and day`() {
        let out = stamp(calendar.date(byAdding: .day, value: -40, to: today)!)
        #expect(out.hasPrefix("Sep 12,"))
        #expect(out.contains("3:00"))
        #expect(!out.contains("2026"))
    }

    @Test func `another year names it`() {
        let out = stamp(calendar.date(byAdding: .year, value: -1, to: today)!)
        #expect(out.hasPrefix("Oct 22, 2025,"))
        #expect(out.contains("3:00"))
    }
}

@Suite struct ModelNameTests {
    @Test(arguments: [
        ("claude-fable-5-1", "Fable 5.1"), ("claude-fable-5", "Fable 5"), ("claude-opus-5-5", "Opus 5.5"),
        ("claude-sonnet-5-5", "Sonnet 5.5"), ("claude-haiku-5-5", "Haiku 5.5"), ("gpt-6.1-sol", "GPT-6.1 Sol"),
        ("gpt-6-astra", "GPT-6 Astra"), ("composer-2.5", "Composer 2.5"), ("foo", "Foo")
    ])
    func `shortens a catalog id the way the row reads it`(id: String, expected: String) {
        #expect(ModelName.short(id) == expected)
    }
}

@Suite struct CompactNumberTests {
    @Test(arguments: [
        (0.0, "0"), (980.0, "980"), (1_000.0, "1K"), (1_234.0, "1.2K"), (9_950.0, "10K"),
        (176_000.0, "176K"), (1_234_567.0, "1.2M"), (-5.0, "0"), (Double.nan, "0"), (Double.infinity, "0")
    ])
    func `tokens read as the desktop's K and M`(count: Double, expected: String) {
        #expect(CompactNumber.tokens(count) == expected)
    }
}
