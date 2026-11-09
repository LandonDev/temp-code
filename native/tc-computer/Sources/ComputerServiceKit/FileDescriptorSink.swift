import Foundation

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// stdout in the binary: every line in full through `write(2)`, which fails (EPIPE) once the host is gone.
public struct FileDescriptorSink: LineSink {
    public let fd: Int32

    public init(fd: Int32) {
        self.fd = fd
    }

    public func write(_ line: Data) throws {
        try line.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.baseAddress else { return }
            var offset = 0
            while offset < raw.count {
                #if canImport(Darwin)
                let written = Darwin.write(fd, base + offset, raw.count - offset)
                #else
                let written = Glibc.write(fd, base + offset, raw.count - offset)
                #endif
                if written < 0 {
                    if errno == EINTR { continue }
                    throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
                }
                offset += written
            }
        }
    }
}
