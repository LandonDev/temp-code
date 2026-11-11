import Foundation

/// The numbers of the transcript's window: how many rows a cold open
/// shows, when the window grows as the reader scrolls back, by how much,
/// and when older rows are asked of the cache or the host.
///
/// The window once grew when its very top came on screen: the page joined
/// above the row the reader was looking at, in the middle of their fling,
/// and the view wrote the offset to hold their place. Now it grows while
/// the reader is still `lookAhead` rows from its top, by `page` rows the
/// thread already holds, so the join lands screens above what is on screen;
/// and older rows are fetched while a page of held rows still lies above
/// the window, so the next growth finds its rows waiting.
public enum TranscriptWindow {
    /// Rows a cold open shows.
    public static let cold = 75
    /// A row this close to the window's top coming on screen grows the window.
    public static let lookAhead = 25
    /// Rows the window grows by, and the held rows above it under which older ones are asked for.
    public static let page = 150

    /// The row at `index` (in the whole list) is near enough to the window's top (`start`) to grow it.
    public static func reaches(index: Int, start: Int) -> Bool {
        index >= start && index - start < lookAhead
    }

    /// How many rows the window shows once it has grown: a page more, or every row held above when fewer are.
    public static func grown(shown: Int, above: Int) -> Int {
        shown + min(page, max(0, above))
    }

    /// Whether older rows are asked for now: fewer than a page of held rows
    /// would lie above the window, the thread has more, and no page is on its way.
    public static func asksOlder(above: Int, moreBefore: Bool, loading: Bool) -> Bool {
        above < page && moreBefore && !loading
    }

    /// How far the rows on screen moved when rows joined above them: the
    /// anchor row's top before and after. The list's bounds move by this
    /// much, and only when it is more than half a point: a write that
    /// changes nothing is no write.
    public static func correction(anchorTopBefore: Double, after: Double) -> Double? {
        let shift = after - anchorTopBefore
        return abs(shift) > 0.5 ? shift : nil
    }
}
