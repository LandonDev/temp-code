// `tc-computer serve`: the Service shell thread writes the server here (docs/computer-protocol.md §1).
import ComputerProtocol
import ComputerService
import Foundation

FileHandle.standardError.write(Data("tc-computer (protocol \(computerProtocol)): the service is not built yet\n".utf8))
exit(64)
