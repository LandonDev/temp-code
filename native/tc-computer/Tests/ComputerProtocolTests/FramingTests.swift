import Foundation
import Testing
@testable import ComputerProtocol

@Suite struct FramingTests {
    @Test func aReaderSplitsLinesAndKeepsAPartialOne() throws {
        var reader = LineReader(maxBytes: 64)
        #expect(try reader.feed(Data("{\"a\":1}\n{\"b\"".utf8)) == [Data("{\"a\":1}".utf8)])
        #expect(try reader.feed(Data(":2}\n\n".utf8)) == [Data("{\"b\":2}".utf8)])
        #expect(try reader.feed(Data()) == [])
    }

    @Test func aReaderRefusesALineOverTheLimit() {
        var reader = LineReader(maxBytes: 8)
        #expect(throws: FramingError.lineTooLong(9)) { _ = try reader.feed(Data("123456789".utf8)) }
    }

    @Test func framesAreToldApartByTheirKeys() throws {
        let request = try decodeLine(Data(#"{"jsonrpc":"2.0","id":3,"method":"permissions.get","params":{}}"#.utf8))
        #expect(request == .request(id: 3, method: "permissions.get", params: .object([:])))
        let note = try decodeLine(Data(#"{"jsonrpc":"2.0","method":"$/cancel","params":{"id":3}}"#.utf8))
        #expect(note == .notification(method: cancelMethod, params: .object(["id": .number(3)])))
        let error = try decodeLine(Data(#"{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}"#.utf8))
        #expect(error == .error(id: nil, error: RPCErrorObject(code: -32700, message: "Parse error")))
        #expect(throws: FramingError.notJSONRPC) { _ = try decodeLine(Data(#"{"id":1,"result":{}}"#.utf8)) }
    }

    @Test func aTypedRequestRoundTripsThroughOneLine() throws {
        let params = Methods.PermissionsRequest.Params(which: .screenRecording)
        let line = try encodeLine(try .request(Methods.PermissionsRequest.self, id: 7, params: params))
        #expect(line.last == 0x0A)
        #expect(!line.dropLast().contains(0x0A))
        guard case .request(7, "permissions.request", let raw) = try decodeLine(line.dropLast()) else {
            Issue.record("not the request")
            return
        }
        #expect(try raw.params(of: Methods.PermissionsRequest.self) == params)
    }

    @Test func aComputerErrorRidesAsMinus32000() {
        let error = RPCErrorObject(ComputerError(kind: .appNotFound, message: "No app named \"Textedt\"."))
        #expect(error.code == -32000)
        #expect(error.data?.kind == .appNotFound)
    }
}
