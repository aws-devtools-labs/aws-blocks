//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

/// Persistent items a `CookieJar` keeps its cookies in: account → stored value.
protocol CookieItemStore {
    func loadAll() -> [String: String]
    func set(name: String, value: String)
    func remove(name: String)
}

/// Stores the cookies of `Set-Cookie` responses and builds the `Cookie` header for requests, applying
/// each cookie's host, `Path`, `Secure` and expiry. See `StoredCookie` for the matching rules.
struct CookieJar {
    let items: any CookieItemStore

    /// The `Cookie` header for a request to `url`: stored cookies that have not expired and whose
    /// host, `Path` and `Secure` attributes match it. Expired cookies found along the way are removed.
    func cookieHeader(for url: URL, now: Date = Date()) -> String? {
        var pairs: [String] = []
        for (account, value) in items.loadAll() {
            guard let cookie = StoredCookie.decode(account: account, value: value) else { continue }
            if cookie.isExpired(at: now) {
                items.remove(name: account)
            } else if cookie.matches(url) {
                pairs.append("\(cookie.name)=\(cookie.value)")
            }
        }
        return pairs.isEmpty ? nil : pairs.joined(separator: "; ")
    }

    /// Stores one `Set-Cookie` header value received in response to `requestURL`.
    func save(setCookie: String, requestURL: URL, now: Date = Date()) {
        guard let cookie = StoredCookie(setCookie: setCookie, requestURL: requestURL, now: now) else { return }

        // As in the Kotlin runtime, a cookie replaces every stored cookie of the same name that would
        // be sent on this request, including one stored by an earlier version under `host|name`.
        for (account, value) in items.loadAll() {
            guard let stored = StoredCookie.decode(account: account, value: value) else { continue }
            if stored.name == cookie.name, stored.matches(requestURL) {
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
