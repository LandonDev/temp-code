import Foundation
import TempCodeContract

/// Transport health, separate from data freshness. The first five states are
/// the desktop runtime's (src/renderer/src/lib/connection/types.ts);
/// `suspended` is the phone's own: the app went to the background, the
/// socket was closed after a short grace, and nothing is tried until it
/// comes forward again.
public enum TransportState: String, Sendable, Hashable, Codable {
    /// No session yet since the environment was added or retried.
    case connecting
    /// A session is up.
    case open
    /// A session was lost; the next attempt is at `nextRetryAt`.
    case reconnecting
    /// Nothing is tried until the network returns, an explicit retry, or the
    /// halt is lifted (the host answered as another environment, or speaks
    /// another contract).
    case offline
    /// The key was refused; only an explicit retry tries again.
    case unauthorized
    /// In the background: closed on purpose, resumed on foreground.
    case suspended
}

/// Why the socket stopped trying by itself. Lifted only by an explicit retry.
public enum HaltReason: Sendable, Hashable {
    /// The host's `hello` named another environment than the one paired.
    case identityChanged(expected: String, got: String)
    /// The host speaks a contract this build does not.
    case contractMismatch(app: Int, host: Int)

    public var message: String {
        switch self {
        case .identityChanged(let expected, let got):
            "host identity changed: expected \(expected), got \(got)"
        case .contractMismatch(let app, let host):
            host > app ? "the host is newer than this app (contract \(host), app speaks \(app))"
                       : "the host is older than this app (contract \(host), app speaks \(app))"
        }
    }
}

public struct EnvironmentStatus: Sendable, Hashable {
    public var transport: TransportState
    /// The stores re-listed on the live session and nothing has failed since.
    public var fresh: Bool
    public var lastHello: HelloPush?
    public var lastError: String?
    /// Clock milliseconds of the next attempt while `reconnecting`.
    public var nextRetryAt: Double?
    /// Failed attempts since the last session that stayed up 30 s.
    public var attempts: Int
    public var halt: HaltReason?

    public init(transport: TransportState, fresh: Bool = false, lastHello: HelloPush? = nil, lastError: String? = nil, nextRetryAt: Double? = nil, attempts: Int = 0, halt: HaltReason? = nil) {
        self.transport = transport
        self.fresh = fresh
        self.lastHello = lastHello
        self.lastError = lastError
        self.nextRetryAt = nextRetryAt
        self.attempts = attempts
        self.halt = halt
    }

    public static let idle = EnvironmentStatus(transport: .offline)
}

/// Why a socket closed. Every close, ours or the network's, carries one.
public struct CloseReason: Sendable, Hashable {
    public enum Kind: String, Sendable, Hashable {
        /// The server refused the credential (4401, 4403, 4001 key revoked).
        case unauthorized
        /// The connection failed or dropped.
        case network
        /// The server closed the socket normally (1000, 1001).
        case server
        /// The server broke the wire's rules (no hello, a hello we cannot accept).
        case `protocol`
        /// We closed it: stop, a failed probe, the background grace.
        case local
        /// A replacement session took over.
        case replaced
    }

    public let kind: Kind
    public let code: Int?
    public let message: String

    public init(kind: Kind, code: Int? = nil, message: String) {
        self.kind = kind
        self.code = code
        self.message = message
    }
}
