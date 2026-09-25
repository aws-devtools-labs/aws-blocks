//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Darwin
import Foundation

/// Loopback TCP listener that captures the first request head a URLSession sends,
/// so a test can assert on the actual wire bytes.
final class LoopbackListener: @unchecked Sendable {
    enum ListenerError: Error { case setupFailed(String) }

    let port: UInt16
    private let socketFD: Int32
    private let sem = DispatchSemaphore(value: 0)
    private var captured = ""

    init() throws {
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { throw ListenerError.setupFailed("socket() failed") }

        var yes: Int32 = 1
        setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        let bindOK = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindOK == 0 else { Darwin.close(sock)
        throw ListenerError.setupFailed("bind() failed")
        }
        guard Darwin.listen(sock, 1) == 0 else { Darwin.close(sock)
        throw ListenerError.setupFailed("listen() failed")
        }

        var bound = sockaddr_in()
        var blen = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &bound) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(sock, $0, &blen) }
        }

        // Non-blocking so the accept loop can poll on a bounded deadline.
        _ = fcntl(sock, F_SETFL, O_NONBLOCK)

        self.socketFD = sock
        self.port = UInt16(bigEndian: bound.sin_port)
        start()
    }

    private func start() {
        DispatchQueue.global().async { [self] in
            defer { sem.signal() }
            guard let client = acceptWithDeadline(seconds: 4) else { return }
            defer { Darwin.close(client) }
            // The accepted socket can inherit the listener's O_NONBLOCK; restore blocking
            // I/O so the timed recv below waits for data instead of returning EAGAIN.
            _ = fcntl(client, F_SETFL, 0)

            // Accepted sockets do not reliably inherit the listener's timeout, so set it.
            var timeout = timeval(tv_sec: 4, tv_usec: 0)
            setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))

            var head = ""
            var buf = [UInt8](repeating: 0, count: 8_192)
            // Read until the end of the HTTP header block, EOF, or timeout, so a
            // request head split across TCP segments is still captured whole.
            while !head.contains("\r\n\r\n") {
                let readCount = recv(client, &buf, buf.count, 0)
                if readCount <= 0 { break }
                head += String(bytes: buf[0 ..< readCount], encoding: .utf8) ?? ""
            }
            captured = head

            let response = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"
            _ = response.withCString { send(client, $0, strlen($0), 0) }
        }
    }

    /// Polls the non-blocking listen socket until a connection is ready or the deadline
    /// elapses, then accepts it. Returns nil on timeout so the loop never blocks forever.
    private func acceptWithDeadline(seconds: Int) -> Int32? {
        let deadline = Date().addingTimeInterval(TimeInterval(seconds))
        while Date() < deadline {
            var pfd = pollfd(fd: socketFD, events: Int16(POLLIN), revents: 0)
            let ready = poll(&pfd, nfds_t(1), 200)
            if ready < 0 {
                if errno == EINTR { continue }
                return nil
            }
            if ready == 0 { continue }
            let client = accept(socketFD, nil, nil)
            if client >= 0 { return client }
            if errno == EAGAIN || errno == EWOULDBLOCK { continue }
            return nil
        }
        return nil
    }

    /// Blocks until the first request head is captured (or the timeout elapses).
    func waitForRequestHead(timeout: TimeInterval = 5) -> String {
        _ = sem.wait(timeout: .now() + timeout)
        return captured
    }

    func close() { Darwin.close(socketFD) }
}
