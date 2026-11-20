//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

/// Persistent items a `CookieJar` keeps its cookies in: account → stored value.
protocol CookieItemStore: Sendable {
    func loadAll() -> [String: String]
    func set(name: String, value: String)
    func remove(name: String)
}

/// Stores the cookies of `Set-Cookie` responses and builds the `Cookie` header for requests, applying
/// each cookie's host, `Path`, `Secure` and expiry. See `StoredCookie` for the matching rules.
///
/// Reading and replacing cookies each take several item operations, so they run under one lock:
/// responses that arrive together are applied one after another, as if received in sequence.
struct CookieJar: Sendable {
    let items: any CookieItemStore
    private let lock = NSLock()

    init(items: any CookieItemStore) {
        self.items = items
    }

    /// The `Cookie` header for a request to `url`: stored cookies that have not expired and whose
    /// host, `Path` and `Secure` attributes match it. Expired cookies found along the way are removed.
    /// Cookies with longer paths come first, so a server that reads the first of several same-named
    /// cookies gets the most specific one.
    func cookieHeader(for url: URL, now: Date = Date()) -> String? {
        lock.lock()
        defer { lock.unlock() }
        var matching: [StoredCookie] = []
        for (account, value) in items.loadAll() {
            guard let cookie = StoredCookie.decode(account: account, value: value) else { continue }
            if cookie.isExpired(at: now) {
                items.remove(name: account)
            } else if cookie.matches(url) {
                matching.append(cookie)
            }
        }
        guard !matching.isEmpty else { return nil }
        return matching
            .sorted { $0.path.count > $1.path.count }
            .map { "\($0.name)=\($0.value)" }
            .joined(separator: "; ")
    }

    /// Removes the stored cookies named in `names` that a request to `url` would send.
    func remove(named names: Set<String>, sentTo url: URL) {
        lock.lock()
        defer { lock.unlock() }
        for (account, value) in items.loadAll() {
            guard let stored = StoredCookie.decode(account: account, value: value) else { continue }
            if names.contains(stored.name), stored.matches(url) {
                items.remove(name: account)
            }
        }
    }

    /// Stores one `Set-Cookie` header value received in response to `requestURL`.
    func save(setCookie: String, requestURL: URL, now: Date = Date()) {
        guard let cookie = StoredCookie(setCookie: setCookie, requestURL: requestURL, now: now) else { return }
        lock.lock()
        defer { lock.unlock() }

        // As in the Kotlin runtime, a cookie replaces every stored cookie of the same name that would
        // be sent on this request. An item stored by an earlier version under `host|name` is replaced
        // by a cookie of the same name from the same host, whatever the request's scheme, so the two
        // are never both kept (see `StoredCookie.decode`).
        for (account, value) in items.loadAll() {
            guard let stored = StoredCookie.decode(account: account, value: value),
                  stored.name == cookie.name else { continue }
            let replacesEarlierVersionItem = StoredCookie.isEarlierVersionItem(account: account, value: value)
                && stored.host.caseInsensitiveCompare(cookie.host) == .orderedSame
            if replacesEarlierVersionItem || stored.matches(requestURL) {
                items.remove(name: account)
            }
        }
        // An empty value or an expiry already passed (`Max-Age=0`, a past `Expires`) deletes the cookie.
        if cookie.value.isEmpty || cookie.isExpired(at: now) {
            items.remove(name: cookie.storageKey)
        } else if let record = cookie.encodedValue() {
            items.set(name: cookie.storageKey, value: record)
        }
    }
}
