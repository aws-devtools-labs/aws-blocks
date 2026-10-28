//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

/// A cookie as `BlocksClient` stores it, with the attributes that decide which requests it is sent on.
///
/// Matching and expiry follow the rules the Kotlin runtime applies through Ktor's `Cookie.matches`:
/// a cookie goes only to the host that set it, only to request paths under its `Path`, and, when
/// `Secure`, only over `https`/`wss`. `Max-Age` takes precedence over `Expires`.
struct StoredCookie: Codable, Equatable, Sendable {
    /// The host that set the cookie. A `Domain` attribute is not honored, so a cookie is never sent
    /// to another host, subdomains included.
    let host: String
    let name: String
    let value: String
    let path: String
    let secure: Bool
    /// When the cookie stops being sent; `nil` for a session cookie.
    let expiresAt: Date?

    /// The Keychain account: host, path and name are what make two cookies the same cookie.
    var storageKey: String {
        "\(host)|\(path)|\(name)"
    }

    init(host: String, name: String, value: String, path: String, secure: Bool, expiresAt: Date?) {
        self.host = host
        self.name = name
        self.value = value
        self.path = path
        self.secure = secure
        self.expiresAt = expiresAt
    }

    /// Parses one `Set-Cookie` header value received in response to `requestURL`.
    init?(setCookie: String, requestURL: URL, now: Date = Date()) {
        let segments = setCookie.split(separator: ";", omittingEmptySubsequences: false)
        guard let nameValuePart = segments.first,
              let eqIdx = nameValuePart.firstIndex(of: "=") else { return nil }

        let name = String(nameValuePart[nameValuePart.startIndex ..< eqIdx])
            .trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return nil }
        let value = String(nameValuePart[nameValuePart.index(after: eqIdx)...])
            .trimmingCharacters(in: .whitespaces)

        var path: String?
        var secure = false
        var maxAge: Int?
        var expires: Date?
        for segment in segments.dropFirst() {
            let parts = segment.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let attrName = parts[0].trimmingCharacters(in: .whitespaces).lowercased()
            let attrValue = parts.count > 1 ? parts[1].trimmingCharacters(in: .whitespaces) : ""
            switch attrName {
            case "path": path = attrValue
            case "secure": secure = true
            case "max-age": maxAge = Int(attrValue) ?? maxAge
            case "expires": expires = StoredCookie.parseDate(attrValue) ?? expires
            default: break
            }
        }

        self.host = requestURL.host ?? ""
        self.name = name
        self.value = value
        self.path = path.flatMap { $0.hasPrefix("/") ? $0 : nil } ?? StoredCookie.defaultPath(for: requestURL)
        self.secure = secure
        // `Max-Age` takes precedence over `Expires`.
        self.expiresAt = maxAge.map { now.addingTimeInterval(TimeInterval($0)) } ?? expires
    }

    /// Reads a Keychain item. A value that is not a record was written by an earlier version under
    /// `host|name`; it is read as what that version sent: `Path=/`, not `Secure`, no expiry.
    static func decode(account: String, value: String) -> StoredCookie? {
        if let cookie = try? JSONDecoder().decode(StoredCookie.self, from: Data(value.utf8)) {
            return cookie
        }
        // An earlier version's account is `host|name`; anything else is not a cookie this can read.
        guard let separator = account.firstIndex(of: "|"),
              !account[account.index(after: separator)...].contains("|") else { return nil }
        return StoredCookie(
            host: String(account[..<separator]),
            name: String(account[account.index(after: separator)...]),
            value: value,
            path: "/",
            secure: false,
            expiresAt: nil
        )
    }

    /// The record stored as the Keychain item's value.
    func encodedValue() -> String? {
        guard let data = try? JSONEncoder().encode(self) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// An expiry that has exactly arrived counts as passed, so a `Max-Age=0` cookie does not
    /// linger for the instant it was received in.
    func isExpired(at now: Date) -> Bool {
        guard let expiresAt else { return false }
        return expiresAt <= now
    }

    /// Whether this cookie belongs on a request to `url`: same host, a path under `path`, and
    /// `https`/`wss` when `Secure`. Paths are compared in their percent-encoded form, and a request
    /// path matches when it equals `path` or continues past it at a `/` (RFC 6265 section 5.1.4).
    func matches(_ url: URL) -> Bool {
        guard let requestHost = url.host, requestHost.caseInsensitiveCompare(host) == .orderedSame else {
            return false
        }
        if secure {
            let scheme = url.scheme?.lowercased()
            guard scheme == "https" || scheme == "wss" else { return false }
        }
        if path == "/" { return true }
        let encodedRequestPath = StoredCookie.encodedPath(of: url)
        let requestPath = encodedRequestPath.isEmpty ? "/" : encodedRequestPath
        if requestPath == path { return true }
        guard requestPath.hasPrefix(path) else { return false }
        return path.hasSuffix("/") || requestPath.dropFirst(path.count).first == "/"
    }

    // MARK: - Private

    /// The path a cookie gets when it carries no usable `Path`: the directory of the request path,
    /// so it applies to the rest of the site rather than only the endpoint that set it.
    private static func defaultPath(for url: URL) -> String {
        let requestPath = encodedPath(of: url)
        guard let lastSlash = requestPath.lastIndex(of: "/"), lastSlash != requestPath.startIndex else {
            return "/"
        }
        return String(requestPath[..<lastSlash])
    }

    private static func encodedPath(of url: URL) -> String {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? url.path
    }

    private static let months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

    /// Parses an `Expires` date, or returns `nil` when it cannot be read. Accepts the formats servers
    /// send — e.g. `Wed, 21 Oct 2015 07:28:00 GMT` and `Wednesday, 21-Oct-15 07:28:00 GMT` — by picking
    /// out the time, day, month and year tokens, in the manner of RFC 6265 section 5.1.1. Always UTC.
    static func parseDate(_ input: String) -> Date? {
        var hour: Int?
        var minute: Int?
        var second: Int?
        var day: Int?
        var month: Int?
        var year: Int?
        let tokens = input.split { $0 == " " || $0 == "," || $0 == "-" || $0 == "\t" }
        for token in tokens {
            let fields = token.split(separator: ":", omittingEmptySubsequences: false)
            if hour == nil, fields.count == 3, fields.allSatisfy({ (1 ... 2).contains($0.count) }),
               let hours = Int(fields[0]), let minutes = Int(fields[1]), let seconds = Int(fields[2]) {
                hour = hours
                minute = minutes
                second = seconds
            } else if day == nil, (1 ... 2).contains(token.count), let number = Int(token) {
                day = number
            } else if month == nil, token.count >= 3,
                      let index = months.firstIndex(of: token.prefix(3).lowercased()) {
                month = index + 1
            } else if year == nil, (2 ... 4).contains(token.count), let number = Int(token) {
                year = number
            }
        }
        guard let hour, let minute, let second, let day, let month, var year,
              (1 ... 31).contains(day), hour < 24, minute < 60, second < 60 else { return nil }
        if year < 70 {
            year += 2_000
        } else if year < 100 {
            year += 1_900
        }

        var calendar = Calendar(identifier: .gregorian)
        guard let utc = TimeZone(identifier: "UTC") else { return nil }
        calendar.timeZone = utc
        let components = DateComponents(
            year: year, month: month, day: day, hour: hour, minute: minute, second: second
        )
        return calendar.date(from: components)
    }
}
