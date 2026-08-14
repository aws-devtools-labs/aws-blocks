//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import SwiftUI

struct CookieTestView: View {
    @EnvironmentObject var appState: AppState

    @State private var cookieName = "session"
    @State private var cookieValue = "abc123"
    @State private var result: ResultMessage?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("Cookie name", text: $cookieName)
                .textFieldStyle(.roundedBorder)
                .autocapitalization(.none)
                .disableAutocorrection(true)

            TextField("Cookie value", text: $cookieValue)
                .textFieldStyle(.roundedBorder)
                .autocapitalization(.none)
                .disableAutocorrection(true)

            HStack {
                Button("Set") { Task { await setCookie() } }
                    .buttonStyle(.borderedProminent)
                Button("Get") { Task { await getCookie() } }
                    .buttonStyle(.bordered)
                Button("Delete") { Task { await deleteCookie() } }
                    .buttonStyle(.bordered)
                    .tint(.red)
            }

            if let result {
                Text(result.text)
                    .font(.caption)
                    .foregroundStyle(result.isError ? .red : .green)
            }
        }
    }

    private func setCookie() async {
        do {
            _ = try await appState.api.setCookie(name: cookieName, value: cookieValue)
            result = ResultMessage(text: "✓ Set cookie \(cookieName) = \(cookieValue)", isError: false)
        } catch {
            result = ResultMessage(text: "✗ \(error.localizedDescription)", isError: true)
        }
    }

    private func getCookie() async {
        do {
            if let value = try await appState.api.getCookie(name: cookieName) {
                result = ResultMessage(text: "✓ Got cookie: \(value)", isError: false)
            } else {
                result = ResultMessage(text: "✗ Cookie not found", isError: true)
            }
        } catch {
            result = ResultMessage(text: "✗ \(error.localizedDescription)", isError: true)
        }
    }

    private func deleteCookie() async {
        do {
            _ = try await appState.api.deleteCookie(name: cookieName)
            result = ResultMessage(text: "✓ Deleted cookie \(cookieName)", isError: false)
        } catch {
            result = ResultMessage(text: "✗ \(error.localizedDescription)", isError: true)
        }
    }
}
