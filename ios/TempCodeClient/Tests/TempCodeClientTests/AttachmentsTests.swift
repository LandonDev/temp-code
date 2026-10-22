import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

@Suite struct AttachmentUploadTests {
    @Test func `the bytes are cut into chunks in order, the last one shorter, an empty file one empty chunk`() {
        let ranges = AttachmentUpload.ranges(size: 10, chunkBytes: 4)
        #expect(ranges == [
            AttachmentUpload.Range(index: 0, offset: 0, length: 4),
            AttachmentUpload.Range(index: 1, offset: 4, length: 4),
            AttachmentUpload.Range(index: 2, offset: 8, length: 2)
        ])
        #expect(AttachmentUpload.ranges(size: 8, chunkBytes: 4).map(\.length) == [4, 4], "an exact multiple has no empty tail")
        #expect(AttachmentUpload.ranges(size: 3, chunkBytes: 4) == [AttachmentUpload.Range(index: 0, offset: 0, length: 3)])
        #expect(AttachmentUpload.ranges(size: 0, chunkBytes: 4) == [AttachmentUpload.Range(index: 0, offset: 0, length: 0)])
        #expect(AttachmentUpload.ranges(size: 5, chunkBytes: 0).count == 5, "a nonsense chunk size still moves forward")
    }

    @Test func `the digest is SHA-256 as lowercase hex`() {
        #expect(AttachmentUpload.sha256Hex(Data()) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        #expect(AttachmentUpload.sha256Hex(Data("abc".utf8)) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    @Test func `begin declares the name, size, mime and digest; the chunk size is the host's, capped at one frame`() {
        let data = Data("hello".utf8)
        let params = AttachmentUpload.beginParams(sessionId: "s1", name: "photo-1.jpeg", mime: "image/jpeg", data: data)
        #expect(params.sessionId == "s1")
        #expect(params.name == "photo-1.jpeg")
        #expect(params.size == 5)
        #expect(params.mime == "image/jpeg")
        #expect(params.sha256 == AttachmentUpload.sha256Hex(data))
        #expect(AttachmentUpload.chunkBytes(answered: 4) == 4)
        #expect(AttachmentUpload.chunkBytes(answered: 8 * 1024 * 1024) == AttachmentUpload.maxChunkBytes)
        #expect(AttachmentUpload.chunkBytes(answered: 0) == 1)
    }
}

@MainActor
@Suite struct UploadActionTests {
    private let bytes = Data((0 ..< 10).map { UInt8($0 + 65) })

    @Test func `an upload is begin, one chunk per range awaited in order, then commit; progress follows the chunks`() async throws {
        let rig = try ActingRig()
        let fake = try await rig.open()
        let progress = Progress()
        let uploading = Task { try await rig.client.upload("s1", name: "photo-1.jpeg", mime: "image/jpeg", data: bytes) { progress.note($0, $1) } }
        let begin = try #require(await rig.request(fake, "attachment.begin"))
        #expect(begin.params == .object(["sessionId": .string("s1"), "name": .string("photo-1.jpeg"), "size": .number(10), "mime": .string("image/jpeg"), "sha256": .string(AttachmentUpload.sha256Hex(bytes))]))
        fake.answer(id: begin.id, result: #"{"uploadId":"u1","chunkBytes":4}"#)
        for (index, slice) in [bytes[0 ..< 4], bytes[4 ..< 8], bytes[8 ..< 10]].enumerated() {
            let chunk = try #require(await rig.request(fake, "attachment.chunk", count: index + 1))
            #expect(chunk.params == .object(["uploadId": .string("u1"), "index": .number(Double(index)), "dataBase64": .string(Data(slice).base64EncodedString())]))
            #expect(fake.sentRequests.filter { $0.method == "attachment.chunk" }.count == index + 1, "the next chunk waits for this answer")
            fake.answer(id: chunk.id, result: #"{"received":\#(min(10, (index + 1) * 4))}"#)
        }
        let commit = try #require(await rig.request(fake, "attachment.commit"))
        #expect(commit.params == .object(["uploadId": .string("u1")]))
        fake.answer(id: commit.id, result: #"{"path":"/tmp/repo/.temp-code/attachments/s1/photo-1.jpeg","name":"photo-1.jpeg","mime":"image/jpeg","kind":"image","size":10}"#)
        let landed = try await uploading.value
        #expect(landed == Attachment(path: "/tmp/repo/.temp-code/attachments/s1/photo-1.jpeg", name: "photo-1.jpeg", mime: "image/jpeg", kind: .image))
        #expect(progress.seen == [[4, 10], [8, 10], [10, 10]])
        #expect(fake.sentRequests.contains { $0.method == "attachment.abort" } == false)
        await rig.client.stop()
    }

    @Test func `a chunk the host refuses aborts the upload and throws what the host said`() async throws {
        let rig = try ActingRig()
        let fake = try await rig.open()
        let uploading = Task { try await rig.client.upload("s1", name: "photo-1.jpeg", mime: "image/jpeg", data: bytes) }
        let begin = try #require(await rig.request(fake, "attachment.begin"))
        fake.answer(id: begin.id, result: #"{"uploadId":"u2","chunkBytes":4}"#)
        let first = try #require(await rig.request(fake, "attachment.chunk"))
        fake.answer(id: first.id, result: #"{"received":4}"#)
        let second = try #require(await rig.request(fake, "attachment.chunk", count: 2))
        fake.refuse(id: second.id, error: "upload u2 expected chunk 1")
        await #expect(throws: ActionError.refused(message: "upload u2 expected chunk 1", forbidden: false)) { try await uploading.value }
        let abort = try #require(await rig.request(fake, "attachment.abort"))
        #expect(abort.params == .object(["uploadId": .string("u2")]))
        fake.answer(id: abort.id, result: "null")
        #expect(fake.sentRequests.contains { $0.method == "attachment.commit" } == false)
        await rig.client.stop()
    }

    @Test func `a cancelled upload aborts on the host`() async throws {
        let rig = try ActingRig()
        let fake = try await rig.open()
        let uploading = Task { try await rig.client.upload("s1", name: "photo-1.jpeg", mime: "image/jpeg", data: bytes) }
        let begin = try #require(await rig.request(fake, "attachment.begin"))
        fake.answer(id: begin.id, result: #"{"uploadId":"u3","chunkBytes":4}"#)
        _ = try #require(await rig.request(fake, "attachment.chunk"))
        uploading.cancel()
        await #expect(throws: ActionError.self) { try await uploading.value }
        let abort = try #require(await rig.request(fake, "attachment.abort"))
        #expect(abort.params == .object(["uploadId": .string("u3")]))
        await rig.client.stop()
    }

    @Test func `a read key is refused before any frame`() async throws {
        let rig = try ActingRig(caps: [.read])
        let fake = try await rig.open()
        await #expect(throws: ActionError.blocked(.readOnly)) { try await rig.client.upload("s1", name: "photo-1.jpeg", mime: "image/jpeg", data: bytes) }
        #expect(fake.sentRequests.contains { $0.method.hasPrefix("attachment.") } == false)
        await rig.client.stop()
    }

    /// The progress calls, in order.
    @MainActor
    private final class Progress {
        var seen: [[Int]] = []
        func note(_ sent: Int, _ total: Int) { seen.append([sent, total]) }
    }
}
