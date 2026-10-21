import SwiftUI

/// The matched text of a search result, emphasized by weight and never by
/// color: every term of the query, wherever it occurs in the text, is set
/// one weight up in the same font. Built off the main actor once per row.
nonisolated enum MatchEmphasis {
    static func attributed(_ text: String, query: String, font: Font, weight: Font.Weight = .semibold) -> AttributedString {
        var out = AttributedString(text)
        out.font = font
        let strong = font.weight(weight)
        for term in terms(of: query) {
            var from = text.startIndex
            while from < text.endIndex,
                  let found = text.range(of: term, options: [.caseInsensitive, .diacriticInsensitive], range: from..<text.endIndex) {
                if let lower = AttributedString.Index(found.lowerBound, within: out),
                   let upper = AttributedString.Index(found.upperBound, within: out), lower < upper {
                    out[lower..<upper].font = strong
                }
                from = found.upperBound
            }
        }
        return out
    }

    /// The query's words, longest first so a longer term claims its run before a shorter one inside it.
    static func terms(of query: String) -> [String] {
        Array(Set(query.split(whereSeparator: \.isWhitespace).map(String.init).filter { !$0.isEmpty }))
            .sorted { $0.count > $1.count }
    }
}

/// One calm line where a list has nothing to show: the hint before a query,
/// the "No results" after one. Secondary, centered, no icon.
struct SearchStatusLine: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 32)
    }
}
