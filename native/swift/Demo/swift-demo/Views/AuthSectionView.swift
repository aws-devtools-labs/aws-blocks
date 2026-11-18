//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import BlocksRuntime
import SwiftUI

struct AuthSectionView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        List {
            // Status
            Section {
                if let user = appState.currentUser {
                    Label("Logged in as: \(user.username)", systemImage: "person.fill")
                        .foregroundStyle(.green)
                } else {
                    Label("Not logged in", systemImage: "person.slash")
                        .foregroundStyle(.secondary)
                }
            }

            // Error
            if let error = appState.error {
                Section {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }

            // Federated sign-in: one button per provider the OIDC client signs in with.
            if !appState.isSignedIn, !appState.federatedProviders.isEmpty {
                Section("Sign in with") {
                    ForEach(appState.federatedProviders, id: \.self) { provider in
                        Button(provider) {
                            Task { await appState.federatedSignIn(provider: provider) }
                        }
                        .frame(maxWidth: .infinity)
                    }
                }
            }

            // Dynamic action forms. The buttons above cover the `signIn:<id>` actions, whose `url`
            // would sign the system browser in, not the app. Passkey actions (`capability` set) need
            // platform WebAuthn APIs, so they are hidden too.
            if let actions = appState.authState?.actions.filter({ $0.capability == nil && !$0.name.hasPrefix("signIn:") }) {
                ForEach(actions, id: \.name) { action in
                    Section(action.label) {
                        AuthActionFormView(action: action)
                    }
                }
            }
        }
    }
}

// MARK: - Dynamic Auth Action Form

struct AuthActionFormView: View {
    @EnvironmentObject var appState: AppState
    let action: AuthAction

    @State private var fieldValues: [String: String] = [:]
    @State private var isLoading = false

    var body: some View {
        ForEach(action.fields, id: \.name) { field in
            if field.type != .hidden {
                if field.type == .password {
                    SecureField(field.label, text: binding(for: field))
                        .textContentType(.password)
                } else {
                    TextField(field.label, text: binding(for: field))
                        .textContentType(contentType(for: field))
                        .autocapitalization(.none)
                        .disableAutocorrection(true)
                }
            }
        }

        Button {
            Task { await submit() }
        } label: {
            if isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity)
            } else {
                Text(action.label)
                    .frame(maxWidth: .infinity)
            }
        }
        .buttonStyle(.borderedProminent)
        // An action that carries `unavailable` can't run in this state.
        .disabled(isLoading || action.unavailable != nil)
        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
        .onAppear {
            for field in action.fields {
                if let defaultValue = field.defaultValue {
                    fieldValues[field.name] = defaultValue
                }
            }
        }

        if let reason = action.unavailable {
            Text(reason)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func binding(for field: AuthField) -> Binding<String> {
        Binding(
            get: { fieldValues[field.name] ?? field.defaultValue ?? "" },
            set: { fieldValues[field.name] = $0 }
        )
    }

    private func contentType(for field: AuthField) -> UITextContentType? {
        switch field.type {
        case .email: return .emailAddress
        case .tel: return .telephoneNumber
        case .password: return .password
        default: return nil
        }
    }

    private func submit() async {
        isLoading = true
        defer { isLoading = false }

        // A federated user's sign-out carries a `url` that would sign the system browser out, not
        // the app: it goes through the OIDC client instead of `setAuthState`.
        if action.name == "signOut", action.url != nil {
            await appState.federatedSignOut()
            return
        }
        let input = buildInput()
        guard let input else { return }
        await appState.performAuthAction(input)
    }

    /// The form value for `field`, falling back to its default (hidden fields carry one).
    private func value(of field: AuthField) -> String {
        fieldValues[field.name] ?? field.defaultValue ?? ""
    }

    private func buildInput() -> AuthApi.SetAuthState.Input? {
        let username = fieldValues["username"] ?? ""
        let password = fieldValues["password"] ?? ""
        let code = fieldValues["code"] ?? ""
        let newPassword = fieldValues["newPassword"] ?? ""

        switch action.name {
        case "signIn":
            return .signIn(AuthApi.SetAuthState.SignIn(password: password, username: username))
        case "signUp":
            // Every field besides the credentials is a user attribute the backend asked for —
            // `email` on the default pool, which Cognito needs to send the confirmation code.
            var attributes: [String: String] = [:]
            for field in action.fields where field.name != "username" && field.name != "password" {
                attributes[field.name] = value(of: field)
            }
            return .signUp(AuthApi.SetAuthState.SignUp(password: password, username: username, attributes: attributes))
        case "confirmSignUp":
            // The emailed code is enough: `Auth` signs the user in afterwards (see `autoSignIn`).
            return .confirmSignUp(
                AuthApi.SetAuthState.ConfirmSignUp(code: code, password: nil, username: username)
            )
        case "resendSignUpCode":
            return .resendSignUpCode(AuthApi.SetAuthState.ResendSignUpCode(username: username))
        case "autoSignIn":
            return .autoSignIn(AuthApi.SetAuthState.AutoSignIn(username: username))
        case "signOut":
            return .signOut
        case "resetPassword":
            return .resetPassword(AuthApi.SetAuthState.ResetPassword(username: username))
        case "confirmResetPassword":
            return .confirmResetPassword(
                AuthApi.SetAuthState.ConfirmResetPassword(code: code, newPassword: newPassword, username: username)
            )
        default:
            return nil
        }
    }
}
