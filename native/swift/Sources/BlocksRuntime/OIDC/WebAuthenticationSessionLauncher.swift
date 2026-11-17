//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

#if os(iOS) || os(macOS) || os(visionOS)
@preconcurrency import AuthenticationServices
import Foundation
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// A ``BrowserLauncher`` that signs in with `ASWebAuthenticationSession`. On iOS it opens the system's sign-in sheet over
/// the app. On macOS the system opens the sign-in in the user's default browser when that browser supports it, else in
/// Safari.
///
/// ```swift
/// let user = try await oidc.signIn(provider: .google, relayTo: "myapp://auth", launcher: WebAuthenticationSessionLauncher())
/// ```
///
/// ``OIDCClient/signIn(provider:relayTo:)`` signs in with one at its defaults.
///
/// `relayTo` must use a custom URL scheme, such as `myapp://auth`, that the backend allows as a relay origin. The session
/// catches the redirect to that scheme itself, so the app doesn't register the scheme in its Info.plist. A relay target with
/// no scheme, or with `http` or `https`, is refused before anything opens. One sign-in opens at a time.
///
/// A launch returns the relay redirect, or throws:
/// - ``OIDCError/cancelled`` when the user closes the sheet or declines the system's sign-in prompt;
/// - `CancellationError` when the calling task is cancelled. The sheet is dismissed first;
/// - ``OIDCError/callbackError(_:_:)`` when the sign-in can't open or fails. The system's error is the cause when it
///   reported one, as it does when it won't show the sheet while the app is in the background. There's no cause when
///   relayTo has no custom scheme, when another sign-in is still open, or when the app shows no window on iOS;
/// - ``OIDCError/invalidAuthorizeURL(_:)`` when the authorize URL isn't `http` or `https`.
public struct WebAuthenticationSessionLauncher: BrowserLauncher {

    /// Whether the session asks the browser for a private session, which shares no cookies with the user's browser, so the
    /// user signs in to the identity provider every time and the system skips its consent prompt. Safari always honors the
    /// request; on macOS, another default browser might not. `false` by default, so a user already signed in to the
    /// provider can reuse that session once the system has asked for consent.
    public let prefersEphemeralWebBrowserSession: Bool

    /// Creates the session a launch drives; a test stands in for the system's sheet with one of its own.
    typealias SessionFactory = @MainActor @Sendable (
        _ url: URL,
        _ callbackScheme: String,
        _ completionHandler: @escaping ASWebAuthenticationSession.CompletionHandler
    ) -> any WebAuthenticationSessionDriver

    private let presentationAnchor: (@MainActor @Sendable () -> ASPresentationAnchor?)?
    private let keyWindow: @MainActor @Sendable () -> ASPresentationAnchor?
    private let makeSession: SessionFactory

    /// Creates a launcher.
    ///
    /// - Parameters:
    ///   - prefersEphemeralWebBrowserSession: Whether to ask for a private browser session. See
    ///     ``prefersEphemeralWebBrowserSession``.
    ///   - presentationAnchor: Returns the window to show the sign-in sheet over, such as the window of the view that
    ///     started sign-in. Called once, on the main actor, as the sign-in opens. When it is `nil` or returns `nil`, the
    ///     launcher uses a key window of one of the app's scenes, preferring a foreground one (on macOS, the key window).
    ///     An app that can show more than one window, such as on iPad, should pass this, and an app extension must.
    public init(
        prefersEphemeralWebBrowserSession: Bool = false,
        presentationAnchor: (@MainActor @Sendable () -> ASPresentationAnchor?)? = nil
    ) {
        self.init(
            prefersEphemeralWebBrowserSession: prefersEphemeralWebBrowserSession,
            presentationAnchor: presentationAnchor,
            keyWindow: { WebAuthenticationSessionLauncher.keyWindow() },
            makeSession: { url, callbackScheme, completionHandler in
                ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme, completionHandler: completionHandler)
            }
        )
    }

    init(
        prefersEphemeralWebBrowserSession: Bool,
        presentationAnchor: (@MainActor @Sendable () -> ASPresentationAnchor?)?,
        keyWindow: @escaping @MainActor @Sendable () -> ASPresentationAnchor?,
        makeSession: @escaping SessionFactory
    ) {
        self.prefersEphemeralWebBrowserSession = prefersEphemeralWebBrowserSession
        self.presentationAnchor = presentationAnchor
        self.keyWindow = keyWindow
        self.makeSession = makeSession
    }

    /// Opens `authorizeURL` in an `ASWebAuthenticationSession` and returns the redirect to `callbackScheme`.
    @MainActor
    public func launch(authorizeURL: URL, callbackScheme: String) async throws -> URL {
        try Self.validate(authorizeURL: authorizeURL, callbackScheme: callbackScheme)
        let attempt = Attempt()
        // Runs on the main actor once the attempt has ended, before the caller sees how.
        defer { attempt.end() }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                open(attempt, authorizeURL: authorizeURL, callbackScheme: callbackScheme, continuation: continuation)
            }
        } onCancel: {
            attempt.cancel()
        }
    }

    @MainActor
    private func open(
        _ attempt: Attempt,
        authorizeURL: URL,
        callbackScheme: String,
        continuation: CheckedContinuation<URL, Error>
    ) {
        // A task cancelled before this point has its continuation resumed here, and nothing opens.
        guard attempt.begin(continuation) else { return }
        // A sheet stacked over another can be left on screen when either is cancelled.
        guard Attempt.presenting == nil else {
            attempt.fail(OIDCError.callbackError("Another sign-in is already open", nil))
            return
        }
        guard let anchor = resolveAnchor() else {
            attempt.fail(OIDCError.callbackError(
                "No window to show the sign-in sheet over. Sign in while the app shows a window, or pass "
                    + "WebAuthenticationSessionLauncher a presentationAnchor.",
                nil
            ))
            return
        }
        Attempt.presenting = attempt
        let session = makeSession(authorizeURL, callbackScheme) { callbackURL, error in
            attempt.complete(Self.outcome(callbackURL: callbackURL, error: error))
        }
        let anchorProvider = PresentationAnchorProvider(anchor: anchor)
        session.presentationContextProvider = anchorProvider
        session.prefersEphemeralWebBrowserSession = prefersEphemeralWebBrowserSession
        guard attempt.hold(session, anchorProvider) else { return }
        // A refused `start()` usually reports why through the completion handler first, and that outcome wins.
        if !session.start() {
            attempt.fail(OIDCError.callbackError("The system couldn't start the sign-in session", nil))
        }
    }

    /// The window to show the sign-in over, or `nil` on iOS when the app shows none: the sheet would never appear.
    @MainActor
    private func resolveAnchor() -> ASPresentationAnchor? {
        if let anchor = presentationAnchor?() ?? keyWindow() {
            return anchor
        }
        #if os(macOS) || targetEnvironment(macCatalyst)
        // The default browser shows its own window; the system only needs a non-nil anchor.
        return ASPresentationAnchor()
        #else
        return nil
        #endif
    }

    /// Refuses what `ASWebAuthenticationSession` can't open, before anything is shown. It raises an Objective-C exception,
    /// which ends the process, for an authorize URL that isn't `http` or `https` and for a callback scheme that isn't a scheme.
    static func validate(authorizeURL: URL, callbackScheme: String) throws {
        guard let scheme = authorizeURL.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
            throw OIDCError.invalidAuthorizeURL(authorizeURL.absoluteString)
        }
        guard isCustomScheme(callbackScheme) else {
            throw OIDCError.callbackError(
                "WebAuthenticationSessionLauncher needs relayTo to use a custom URL scheme, such as myapp://auth, not \"\(callbackScheme)\"",
                nil
            )
        }
    }

    /// A URL scheme (RFC 3986: a letter, then letters, digits, `+`, `-` or `.`) other than `http` and `https`.
    static func isCustomScheme(_ scheme: String) -> Bool {
        let letters = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
        let schemeCharacters = letters.union(CharacterSet(charactersIn: "0123456789+-."))
        guard let first = scheme.unicodeScalars.first, letters.contains(first),
              scheme.unicodeScalars.allSatisfy({ schemeCharacters.contains($0) }) else {
            return false
        }
        return !["http", "https"].contains(scheme.lowercased())
    }

    /// How a session that called its completion handler ended.
    static func outcome(callbackURL: URL?, error: Error?) -> Result<URL, Error> {
        if let callbackURL {
            return .success(callbackURL)
        }
        guard let error else {
            return .failure(OIDCError.callbackError("The sign-in session ended without a redirect", nil))
        }
        if let sessionError = error as? ASWebAuthenticationSessionError {
            switch sessionError.code {
            case .canceledLogin:
                return .failure(OIDCError.cancelled)
            case .presentationContextNotProvided, .presentationContextInvalid:
                return .failure(OIDCError.callbackError(
                    "The system won't show the sign-in sheet. Sign in while the app is in the foreground, or pass "
                        + "WebAuthenticationSessionLauncher a presentationAnchor that returns a window in a foreground scene.",
                    error
                ))
            @unknown default:
                break
            }
        }
        return .failure(OIDCError.callbackError("The sign-in session failed: \(error.localizedDescription)", error))
    }

    /// A key window of one of the app's scenes, foreground ones first (on macOS, the key window). `nil` when the app shows
    /// no window, or in an app extension, which has no application to ask.
    @MainActor
    static func keyWindow() -> ASPresentationAnchor? {
        #if canImport(UIKit)
        // Looked up by name: `UIApplication.shared` doesn't compile in an app extension, which can link this runtime too.
        guard let app = UIApplication.value(forKey: "sharedApplication") as? UIApplication else {
            return nil
        }
        let scenes = app.connectedScenes.compactMap { $0 as? UIWindowScene }
        let foreground = scenes.filter { $0.activationState == .foregroundActive }
        let background = scenes.filter { $0.activationState != .foregroundActive }
        return (foreground + background).lazy.compactMap { $0.keyWindow ?? $0.windows.first }.first
        #else
        let app = NSApplication.shared
        return app.keyWindow ?? app.mainWindow ?? app.windows.first { $0.isVisible }
        #endif
    }
}

public extension OIDCClient {

    /// Signs in through the system's sign-in sheet: ``signIn(provider:relayTo:launcher:)`` with a
    /// ``WebAuthenticationSessionLauncher`` at its defaults.
    ///
    /// Pass a launcher instead to choose the window the sheet opens over or to ask for a private browser session.
    func signIn(provider: Provider, relayTo: String) async throws -> OIDCUser {
        try await signIn(provider: provider, relayTo: relayTo, launcher: WebAuthenticationSessionLauncher())
    }
}

// MARK: - Session

/// The parts of `ASWebAuthenticationSession` a launch uses.
@MainActor
protocol WebAuthenticationSessionDriver: AnyObject {
    /// Held weakly, as `ASWebAuthenticationSession` holds it.
    var presentationContextProvider: (any ASWebAuthenticationPresentationContextProviding)? { get set }
    var prefersEphemeralWebBrowserSession: Bool { get set }
    func start() -> Bool
    func cancel()
}

extension ASWebAuthenticationSession: WebAuthenticationSessionDriver {}

/// Answers the session's request for a window with the one the launch resolved.
@MainActor
final class PresentationAnchorProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let anchor: ASPresentationAnchor

    init(anchor: ASPresentationAnchor) {
        self.anchor = anchor
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        anchor
    }
}

/// One launch. The task's cancellation handler and the session's completion handler run on any thread, so the
/// continuation and how the attempt ended sit behind a lock. The session and its anchor provider are main-actor only.
private final class Attempt: @unchecked Sendable {
    /// The launch whose sign-in is open, across launchers: `signIn(provider:relayTo:)` makes one per call.
    @MainActor static weak var presenting: Attempt?

    private let lock = NSLock()
    private var continuation: CheckedContinuation<URL, Error>?
    private var isCancelled = false
    /// The session called its completion handler, so it has nothing left to dismiss.
    private var sessionEnded = false

    private var session: (any WebAuthenticationSessionDriver)?
    /// Kept here because the session holds its provider weakly.
    private var anchorProvider: PresentationAnchorProvider?

    /// Keeps `continuation` for the attempt to resume. When the task is already cancelled, resumes it with
    /// `CancellationError` instead and returns `false`.
    func begin(_ continuation: CheckedContinuation<URL, Error>) -> Bool {
        let cancelled = lock.withLock {
            if !isCancelled {
                self.continuation = continuation
            }
            return isCancelled
        }
        if cancelled {
            continuation.resume(throwing: CancellationError())
        }
        return !cancelled
    }

    /// Keeps the session until the attempt ends: a released `ASWebAuthenticationSession` stops. Returns `false` when the
    /// attempt has already ended, because the task was cancelled.
    @MainActor
    func hold(_ session: any WebAuthenticationSessionDriver, _ anchorProvider: PresentationAnchorProvider) -> Bool {
        self.session = session
        self.anchorProvider = anchorProvider
        return lock.withLock { continuation != nil }
    }

    /// The session's completion handler: ends the attempt with how the session ended.
    func complete(_ outcome: Result<URL, Error>) {
        lock.withLock { sessionEnded = true }
        resume(with: outcome)
    }

    /// Ends the attempt with the launcher's own error.
    func fail(_ error: Error) {
        resume(with: .failure(error))
    }

    /// The task's cancellation handler.
    func cancel() {
        lock.withLock { isCancelled = true }
        resume(with: .failure(CancellationError()))
    }

    /// Resumes the continuation the first time only.
    private func resume(with outcome: Result<URL, Error>) {
        let continuation: CheckedContinuation<URL, Error>? = lock.withLock {
            defer { self.continuation = nil }
            return self.continuation
        }
        continuation?.resume(with: outcome)
    }

    /// Dismisses a session the system hasn't ended (the task was cancelled, or it never started), lets it go, and frees the
    /// slot for the next sign-in.
    @MainActor
    func end() {
        if !lock.withLock({ sessionEnded }) {
            session?.cancel()
        }
        session = nil
        anchorProvider = nil
        if Attempt.presenting === self {
            Attempt.presenting = nil
        }
    }
}
#endif
