import ComputerProtocol
import Foundation

/// The `pick` route's choice of item (docs/computer-protocol.md §25.7): the open menu's item whose
/// title is the value, exact first, then case-blind, then the one item it is a prefix of. Titles
/// and the value are compared trimmed; an empty value names nothing.
public enum PickPlan {
    /// An item's name: its AXTitle, else its AXValue, else its AXDescription. Chrome 156 leaves a select's menu items
    /// untitled and gives each option's text as its value (2026-11-11).
    public static func itemName(title: String?, value: String?, description: String?) -> String {
        [title, value, description].lazy.compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }.first { !$0.isEmpty } ?? ""
    }

    public enum Match: Equatable, Sendable {
        /// the item at this index of the titles
        case item(Int)
        /// no item has that title or begins with it
        case none
        /// the value begins several titles: these, in menu order
        case ambiguous([String])
    }

    public static func match(_ value: String, titles: [String]) -> Match {
        let want = trimmed(value)
        guard !want.isEmpty else { return .none }
        let items = titles.map(trimmed)
        if let i = items.firstIndex(of: want) { return .item(i) }
        let blind = fold(want)
        if let i = items.firstIndex(where: { fold($0) == blind }) { return .item(i) }
        let prefixed = items.indices.filter { !items[$0].isEmpty && fold(items[$0]).hasPrefix(blind) }
        switch prefixed.count {
        case 0: return .none
        case 1: return .item(prefixed[0])
        default: return .ambiguous(prefixed.map { titles[$0] })
        }
    }

    static func trimmed(_ s: String) -> String {
        s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Case and width blind, as a person reads two titles as the same.
    static func fold(_ s: String) -> String {
        s.folding(options: [.caseInsensitive, .widthInsensitive], locale: nil)
    }
}
