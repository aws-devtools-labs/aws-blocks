//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation
import os

/// The only path to a client's `URLSession`, so no task is ever created on an invalidated one.
final class SessionGate: Sendable {
    private let session: URLSession
    private let state: OSAllocatedUnfairLock<State>

    init(session: URLSession, ownsSession: Bool) {
        self.session = session
        self.state = OSAllocatedUnfairLock(initialState: State(ownsSession: ownsSession))
    }

    // Nothing can send once the last reference is gone.
    deinit {
        close()
    }

    var configuration: URLSessionConfiguration {
        session.configuration
    }

    /// Whether the owned session has been invalidated; read by tests.
    var isInvalidated: Bool {
        state.withLock { $0.invalidated }
    }

    /// Throws `ClientClosedError` once closed; otherwise counts the request as in flight until it ends.
    func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        try state.withLock { try $0.begin() }
        defer { invalidate(if: state.withLock { $0.end() }) }
        return try await session.data(for: request)
    }

    /// Rejects later sends; an owned session is invalidated once no send is in flight.
    func close() {
        invalidate(if: state.withLock { $0.close() })
    }

    // Runs outside the lock.
    private func invalidate(if shouldInvalidate: Bool) {
        if shouldInvalidate {
            session.finishTasksAndInvalidate()
        }
    }

    private struct State {
        let ownsSession: Bool
        var closed = false
        var inFlight = 0
        var invalidated = false

        mutating func begin() throws {
            if closed {
                throw ClientClosedError()
            }
            inFlight += 1
        }

        // `end()` and `close()` return true when the caller must invalidate now.
        mutating func end() -> Bool {
            inFlight -= 1
            return takeInvalidation()
        }

        mutating func close() -> Bool {
            closed = true
            return takeInvalidation()
        }

        private mutating func takeInvalidation() -> Bool {
            guard ownsSession, closed, inFlight == 0, !invalidated else { return false }
            invalidated = true
            return true
        }
    }
}
