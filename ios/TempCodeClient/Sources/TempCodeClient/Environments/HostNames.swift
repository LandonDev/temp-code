import Foundation
import TempCodeContract

/// What a host is called on the phone, and which relayed rows are the same
/// machine twice. The desktop's copy of the naming rule is
/// src/shared/hostNames.ts; keep the two equal.
public enum HostNames {
    /// "Mac.attlocal.net" → "Mac": a hostname without the network's domain. An
    /// address, a name with no dot, or one whose first label is empty stays whole.
    public static func short(_ name: String) -> String {
        let text = name.trimmingCharacters(in: .whitespaces)
        guard text.contains("."), !text.contains(":"), !isIPv4(text) else { return text }
        let first = text.split(separator: ".", omittingEmptySubsequences: false).first.map(String.init) ?? ""
        return first.isEmpty ? text : first
    }

    /// One host to label: its own name, and whether the person gave it.
    public struct Entry: Sendable, Hashable {
        public let id: String
        public let name: String
        public let custom: Bool

        public init(id: String, name: String, custom: Bool = false) {
            self.id = id
            self.name = name
            self.custom = custom
        }
    }

    /// One label per id: each name shortened, except where two hosts would
    /// read the same (ignoring case), which keep their names whole. A name
    /// the person gave is never shortened.
    public static func labels(_ entries: [Entry]) -> [String: String] {
        let shortened = entries.map { entry -> (id: String, full: String, label: String) in
            let full = entry.name.trimmingCharacters(in: .whitespaces)
            return (entry.id, full, entry.custom ? full : short(entry.name))
        }
        var counts: [String: Int] = [:]
        for entry in shortened { counts[entry.label.lowercased(), default: 0] += 1 }
        var out: [String: String] = [:]
        for entry in shortened where out[entry.id] == nil {
            out[entry.id] = (counts[entry.label.lowercased()] ?? 0) > 1 ? entry.full : entry.label
        }
        return out
    }

    /// Two names of one machine across builds: an older host says
    /// "Mac.attlocal.net", a newer one "Mac".
    public static func sameMachine(_ a: String, _ b: String) -> Bool {
        short(a).lowercased() == short(b).lowercased()
    }

    /// The relayed rows that are a machine the phone already has under
    /// another id: a down row whose name and platform match a host that is up
    /// and came up after it went down (the same Mac under a new environment
    /// id), or match the carrier itself (a host never relays itself). Two
    /// live machines of one name keep both rows. An unknown platform proves
    /// nothing.
    public static func pastIdentities(_ list: [HostPresence], carrierName: String?, carrierPlatform: String?) -> Set<String> {
        var gone: Set<String> = []
        for row in list where row.link.rawValue == "down" && row.platform != "unknown" {
            if let carrierName, let carrierPlatform, carrierPlatform == row.platform, sameMachine(carrierName, row.name) {
                gone.insert(row.environmentId)
                continue
            }
            let replaced = list.contains { other in
                other.environmentId != row.environmentId && other.link.rawValue == "up" && other.platform == row.platform
                    && other.since >= row.since && sameMachine(other.name, row.name)
            }
            if replaced { gone.insert(row.environmentId) }
        }
        return gone
    }

    private static func isIPv4(_ text: String) -> Bool {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 4 && parts.allSatisfy { !$0.isEmpty && $0.count <= 3 && $0.allSatisfy(\.isNumber) }
    }
}
