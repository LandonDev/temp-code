import Foundation

/// The desktop's time formats (src/renderer/src/lib/format.ts), so the two
/// apps read the same at a glance. Every string here is digits a stamp can
/// roll: the app's LiveText views wrap them. Pure, so the package tests it.
public enum TimeFormat {
    /// "now", "3m", "2h", "5d", then "Oct 3". An epoch of zero or less reads as nothing.
    public static func ago(_ ms: Int, now: Date = .now) -> String {
        guard ms > 0 else { return "" }
        let seconds = max(0, Int((now.timeIntervalSince1970 - Double(ms) / 1000).rounded()))
        if seconds < 60 { return "now" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }
        let days = hours / 24
        if days < 7 { return "\(days)d" }
        return Date(timeIntervalSince1970: Double(ms) / 1000).formatted(.dateTime.month(.abbreviated).day())
    }

    /// "12s", "3m 4s", "2h 5m", "1d 3h"; never below "0s".
    public static func duration(ms: Int) -> String {
        let s = max(0, ms / 1000)
        if s < 60 { return "\(s)s" }
        let m = s / 60
        if m < 60 { return "\(m)m \(s % 60)s" }
        let h = m / 60
        if h < 24 { return "\(h)h \(m % 60)m" }
        return "\(h / 24)d \(h % 24)h"
    }

    /// The running span since `ms`, as of `now`.
    public static func elapsed(since ms: Int, now: Date = .now) -> String {
        duration(ms: Int(now.timeIntervalSince1970 * 1000) - ms)
    }

    /// A moment as a transcript stamp reads it: "9:41 AM" today, "Mon 9:41 AM"
    /// within six days, "Oct 3, 9:41 AM" before that; the year only when it
    /// differs. `calendar` carries the time zone and locale a test fixes.
    public static func stamp(_ ms: Int, now: Date = .now, calendar: Calendar = .current) -> String {
        let date = Date(timeIntervalSince1970: Double(ms) / 1000)
        let locale = calendar.locale ?? .current
        let zone = calendar.timeZone
        func format(_ style: Date.FormatStyle) -> String {
            var style = style
            style.locale = locale
            style.timeZone = zone
            return date.formatted(style)
        }
        let time = format(.dateTime.hour().minute())
        if calendar.isDate(date, inSameDayAs: now) { return time }
        if let week = calendar.date(byAdding: .day, value: -6, to: now), date > week {
            return "\(format(.dateTime.weekday(.abbreviated))) \(time)"
        }
        if calendar.isDate(date, equalTo: now, toGranularity: .year) {
            return "\(format(.dateTime.month(.abbreviated).day())), \(time)"
        }
        return "\(format(.dateTime.month(.abbreviated).day().year())), \(time)"
    }
}
