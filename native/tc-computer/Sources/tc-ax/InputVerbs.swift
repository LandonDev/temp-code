#if canImport(ApplicationServices)
import AXReader
import ComputerCore
import ComputerProtocol
import Foundation
import Input

/// tc-ax's session verbs for web controls' hand run (docs/computer-protocol.md §25.6, §25.7), each the
/// same code a step runs: `pick <i> <value>` (the value as the rest of the line, or a JSON string) and
/// `into-view <i> <up|down|left|right> <clicks>` (from a web area, or an element in one).
extension Live {
    static let inputVerbs: Set<String> = ["pick", "into-view"]

    static func inputVerb(_ verb: String, line: String, reader: AppReader) {
        struct Picked: Encodable { var ok = true; var item: String }
        struct IntoView: Encodable { var ok = true; var moved: Bool; var on: String? }
        answer { () throws -> AnyEncodable in
            let rest = line.dropFirst(verb.count).trimmingCharacters(in: .whitespaces)
            let parts = rest.split(separator: " ", maxSplits: 1).map(String.init)
            guard let i = parts.first.flatMap(Int.init) else { throw ComputerFailure(.unknown("usage"), "\(verb) <i> …") }
            let e = try reader.resolve(i)
            let arg = parts.count > 1 ? parts[1] : ""
            switch verb {
            case "pick":
                let value = arg.hasPrefix("\"") ? ((try? JSONDecoder().decode(String.self, from: Data(arg.utf8))) ?? arg) : arg
                return AnyEncodable(Picked(item: try WebControls.pick(e, value: value, pid: reader.pid)))
            default:
                let words = arg.split(separator: " ").map(String.init)
                guard words.count == 2, let clicks = Int(words[1]), let direction = ["up", "down", "left", "right"].contains(words[0]) ? ScrollDirection(rawValue: words[0]) : nil else {
                    throw ComputerFailure(.unknown("usage"), "into-view <i> <up|down|left|right> <clicks>")
                }
                let on = WebControls.scrollIntoView(e, direction: direction, clicks: clicks)
                return AnyEncodable(IntoView(moved: on != nil, on: on))
            }
        }
    }
}

/// One answer of either shape.
struct AnyEncodable: Encodable {
    private let body: (Encoder) throws -> Void
    init<T: Encodable>(_ value: T) { body = { try value.encode(to: $0) } }
    func encode(to encoder: Encoder) throws { try body(encoder) }
}
#endif
