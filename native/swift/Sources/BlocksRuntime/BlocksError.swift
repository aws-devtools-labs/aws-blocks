//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

/// Protocol for all errors thrown by the CDK Blocks runtime.
public protocol BlocksError: Error {
    var message: String { get }
    var underlyingError: Error? { get }
}

public extension BlocksError {
    var underlyingError: Error? { nil }
}

/// Errors thrown by generated code (models and API extensions).
public enum CodegenError: BlocksError {
    case validation(String)

    public var message: String {
        switch self {
        case .validation(let msg): return msg
        }
    }
}

/// Thrown when the server answers with a JSON-RPC error: the request reached the server
/// and was rejected (authentication required, validation failed, a conflict).
public struct ApiError: BlocksError {
    /// The server's own message, passed through unchanged.
    public let message: String

    /// The HTTP status the server rejected with. JSON-RPC's reserved codes have no HTTP
    /// meaning and are reported as 500.
    public let status: Int

    /// The server's error name, or `nil` when it sent none. Errors cross the wire by name,
    /// so match on this rather than on `message` or `status` — a named error thrown without
    /// a status arrives as a 500 with its name intact. `nil` when the server sent none or
    /// sent a name that is not a string.
    public let name: String?

    /// Whether the same action can be retried without restarting the wider flow. Meaningful
    /// for multi-step flows such as an auth challenge, where a wrong code can be re-entered
    /// against the same session but an expired session cannot. `true` only when the server
    /// sent the JSON boolean `true`; it marks the kind of failure as retriable, not that a
    /// given retry will succeed.
    public let retriable: Bool

    public init(message: String, status: Int, name: String? = nil, retriable: Bool = false) {
        self.message = message
        self.status = status
        self.name = name
        self.retriable = retriable
    }
}

/// Thrown when a request produced no usable JSON-RPC result: the connection failed, the
/// response carried no JSON-RPC envelope (a gateway's own error page), or an envelope
/// arrived with no `result` field.
///
/// A request the server considered and rejected is an `ApiError` instead.
public struct TransportError: BlocksError {
    public let message: String

    /// The HTTP status of the response, or `nil` when no response arrived at all.
    public let statusCode: Int?

    public let underlyingError: Error?

    public init(message: String, statusCode: Int? = nil, underlyingError: Error? = nil) {
        self.message = message
        self.statusCode = statusCode
        self.underlyingError = underlyingError
    }
}

public extension Error {
    /// True when this is an `ApiError` whose `name` is `name` (e.g. `"NotAuthenticatedException"`).
    /// Errors cross the wire by name, so match with this rather than on a message or a status.
    /// Like Kotlin's `Throwable.isBlocksError`, it is offered on any `Error`, and is `false`
    /// for transport and decoding failures.
    func isBlocksError(name: String) -> Bool {
        (self as? ApiError)?.name == name
    }
}

/// The error name for a reserved JSON-RPC `code`, or `nil` for any other code.
///
/// The server names some protocol-level failures and not others — it sends no `data` at all
/// for a method-not-found or a parse error — so reporting the code as a 500 would leave those
/// indistinguishable from a crashed handler. These names are the server's own vocabulary for
/// the same codes, so a name it does send is identical to the one here. A name the server
/// sent always takes precedence; this only fills a gap.
func reservedRpcErrorName(_ code: Int) -> String? {
    switch code {
    case -32_700: return "ParseError"
    case -32_600: return "InvalidRequest"
    case -32_601: return "MethodNotFound"
    case -32_602: return "InvalidParams"
    case -32_603: return "InternalError"
    default: return nil
    }
}
