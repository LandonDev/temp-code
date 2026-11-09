import AppKit
import ComputerCore
import ComputerProtocol
import Foundation

/// NSPasteboard as the paste flow uses it: the general pasteboard in the service, a uniquely
/// named private one in the tests.
public final class SystemPasteboard: PasteboardStore, @unchecked Sendable {
    public let pasteboard: NSPasteboard

    public init(_ pasteboard: NSPasteboard = .general) {
        self.pasteboard = pasteboard
    }

    public var changeCount: Int { pasteboard.changeCount }

    public func snapshot() throws -> PasteboardSnapshot {
        let start = pasteboard.changeCount
        var items: [PasteboardItemData] = []
        for item in pasteboard.pasteboardItems ?? [] {
            var data: [String: Data] = [:]
            for type in item.types {
                guard let d = item.data(forType: type) else { throw clipboardBusy("The clipboard holds data that can't be saved; nothing was pasted.") }
                data[type.rawValue] = d
            }
            items.append(PasteboardItemData(types: item.types.map(\.rawValue), data: data))
        }
        if pasteboard.changeCount != start { throw clipboardBusy("The clipboard changed while the paste read it; nothing was pasted.") }
        return PasteboardSnapshot(items: items, changeCount: start)
    }

    public func clear() {
        pasteboard.clearContents()
    }

    public func write(_ content: PasteContent) throws {
        let item = NSPasteboardItem()
        if let html = content.html { item.setString(html, forType: .html) }
        if let rtf = content.rtf { item.setData(rtf, forType: .rtf) }
        item.setString(content.plain, forType: .string)
        guard pasteboard.writeObjects([item]) else { throw clipboardBusy("The clipboard refused the paste's text.") }
    }

    public func restore(_ snapshot: PasteboardSnapshot) {
        pasteboard.clearContents()
        let items = snapshot.items.map { saved -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for type in saved.types { if let d = saved.data[type] { item.setData(d, forType: NSPasteboard.PasteboardType(type)) } }
            return item
        }
        if !items.isEmpty { pasteboard.writeObjects(items) }
    }
}

extension PasteContent {
    /// What a `paste` of this format writes: plain text alone; markdown as rendered HTML and RTF
    /// with its source as the plain string; HTML as given with its text as the plain string.
    public static func make(_ text: String, format: PasteFormat?) -> PasteContent {
        switch format {
        case .markdown:
            PasteContent(plain: text, html: MarkdownHTML.html(fromMarkdown: text), rtf: RichTextRTF.rtf(fromMarkdown: text))
        case .html:
            PasteContent(plain: MarkdownHTML.plainText(fromHTML: text), html: text)
        default:
            PasteContent(plain: text)
        }
    }
}
