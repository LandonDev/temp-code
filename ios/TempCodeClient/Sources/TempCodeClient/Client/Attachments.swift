import CryptoKit
import Foundation
import TempCodeContract

/// The pure half of a photo upload: how the bytes are cut into chunks, the
/// digest `attachment.begin` declares, and the begin params. Tested without
/// a host; `EnvironmentClient.upload` is built on it.
public enum AttachmentUpload {
    /// Raw bytes per `attachment.chunk` frame at most, the host's own ceiling
    /// (contract-attachments.ts `ATTACHMENT_CHUNK_BYTES`).
    public static let maxChunkBytes = 2 * 1024 * 1024

    /// One chunk: its index on the wire and the bytes it carries.
    public struct Range: Hashable, Sendable {
        public let index: Int
        public let offset: Int
        public let length: Int

        public init(index: Int, offset: Int, length: Int) {
            self.index = index
            self.offset = offset
            self.length = length
        }
    }

    /// The chunks of `size` bytes at `chunkBytes` each, the last one shorter.
    /// An empty file is one empty chunk, so the host still sees a frame.
    public static func ranges(size: Int, chunkBytes: Int) -> [Range] {
        let step = max(1, chunkBytes)
        guard size > 0 else { return [Range(index: 0, offset: 0, length: 0)] }
        return stride(from: 0, to: size, by: step).enumerated().map { index, offset in
            Range(index: index, offset: offset, length: min(step, size - offset))
        }
    }

    /// SHA-256 of the bytes as lowercase hex, what `attachment.begin` declares
    /// and `attachment.commit` checks.
    public static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// The host's chunk size, capped at what one frame may carry.
    public static func chunkBytes(answered: Int) -> Int {
        min(max(1, answered), maxChunkBytes)
    }

    public static func beginParams(sessionId: String, name: String, mime: String?, data: Data) -> Methods.AttachmentBegin.Params {
        .init(sessionId: sessionId, name: name, size: data.count, mime: mime, sha256: sha256Hex(data))
    }
}

extension EnvironmentClient {
    /// A photo (or any bytes) onto the thread's host, the way the desktop
    /// streams a file to a remote thread: `attachment.begin`, then one
    /// `attachment.chunk` per range in order, each awaited before the next
    /// (that is the backpressure), then `attachment.commit`, whose answer is
    /// the `Attachment` the next `send` names. `progress` is told the bytes
    /// sent after every chunk. A refusal after `begin` aborts the upload on
    /// the host and throws; a cancelled task aborts it too.
    public func upload(_ sessionId: String, name: String, mime: String?, data: Data, progress: (_ sent: Int, _ total: Int) -> Void = { _, _ in }) async throws -> Attachment {
        if let block = operateBlock { throw ActionError.blocked(block) }
        let begun: AttachmentBeginAnswer
        do {
            begun = try await request(Methods.AttachmentBegin.self, AttachmentUpload.beginParams(sessionId: sessionId, name: name, mime: mime, data: data))
        } catch {
            throw ActionError.wrap(error)
        }
        do {
            let step = AttachmentUpload.chunkBytes(answered: begun.chunkBytes)
            for range in AttachmentUpload.ranges(size: data.count, chunkBytes: step) {
                try Task.checkCancellation()
                let bytes = data.subdata(in: range.offset ..< range.offset + range.length)
                _ = try await request(Methods.AttachmentChunk.self, .init(uploadId: begun.uploadId, index: range.index, dataBase64: bytes.base64EncodedString()))
                progress(range.offset + range.length, data.count)
            }
            try Task.checkCancellation()
            let committed = try await request(Methods.AttachmentCommit.self, .init(uploadId: begun.uploadId))
            return Attachment(path: committed.path, name: committed.name, mime: committed.mime, kind: Attachment.Kind(rawValue: committed.kind.rawValue))
        } catch {
            // The host drops the partial file. Its own task, so a cancelled upload still asks.
            let uploadId = begun.uploadId
            Task { _ = try? await self.request(Methods.AttachmentAbort.self, .init(uploadId: uploadId)) }
            throw ActionError.wrap(error)
        }
    }
}
