//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

#if os(iOS) || os(macOS) || os(visionOS)
import AuthenticationServices
import XCTest
@testable import BlocksRuntime

private let authorizeURL = URL(string: "https://idp.example.com/authorize?state=s")!
private let redirect = URL(string: "myapp://auth?code=c&state=s")!

/// The launcher's completion handler, callable from any thread, as the system calls it.
struct CompletionHandlerBox: @unchecked Sendable {
    let handler: ASWebAuthenticationSession.CompletionHandler
}

/// Stands in for the system's sign-in sheet.
@MainActor
final class FakeWebAuthenticationSession: WebAuthenticationSessionDriver {
    let url: URL
    let callbackScheme: String
    nonisolated let completion: CompletionHandlerBox

    weak var presentationContextProvider: (any ASWebAuthenticationPresentationContextProviding)?
    var prefersEphemeralWebBrowserSession = false
    /// What `start()` returns.
    var startResult = true
    /// Runs inside `start()`. By default the session completes with the redirect at once, so a test that expects no
    /// session to start fails instead of hanging when one does.
    var onStart: @MainActor (FakeWebAuthenticationSession) -> Void = { $0.finish(redirect, nil) }
    private(set) var startCount = 0
    private(set) var cancelCount = 0

    init(url: URL, callbackScheme: String, completionHandler: @escaping ASWebAuthenticationSession.CompletionHandler) {
        self.url = url
        self.callbackScheme = callbackScheme
        self.completion = CompletionHandlerBox(handler: completionHandler)
    }

    func start() -> Bool {
        startCount += 1
        onStart(self)
        return startResult
    }

    func cancel() {
        cancelCount += 1
    }

    /// Ends the session as the system does, through its completion handler.
    func finish(_ callbackURL: URL?, _ error: Error?) {
        completion.handler(callbackURL, error)
    }

    /// Ends the session with `callbackURL` from a background thread, as the system can.
    nonisolated func finishFromAnotherThread(with callbackURL: URL) {
        let completion = completion
        DispatchQueue.global().async { completion.handler(callbackURL, nil) }
    }
}

/// Makes the sessions a launcher drives. Holds the latest one weakly, so a test sees when the launcher lets it go.
@MainActor
final class FakeSessionFactory {
    /// Runs on each new session before the launcher starts it.
    var configure: @MainActor (FakeWebAuthenticationSession) -> Void = { _ in }
    private(set) var created = 0
    private(set) weak var last: FakeWebAuthenticationSession?

    /// A launcher on fake sessions. Its key window is a window of its own, so the tests don't depend on the app's.
    func launcher(
        prefersEphemeralWebBrowserSession: Bool = WebAuthenticationSessionLauncher().prefersEphemeralWebBrowserSession,
        presentationAnchor: (@MainActor @Sendable () -> ASPresentationAnchor?)? = nil,
        keyWindow: (@MainActor @Sendable () -> ASPresentationAnchor?)? = nil
    ) -> WebAuthenticationSessionLauncher {
        let window = ASPresentationAnchor()
        return WebAuthenticationSessionLauncher(
            prefersEphemeralWebBrowserSession: prefersEphemeralWebBrowserSession,
            presentationAnchor: presentationAnchor,
            keyWindow: keyWindow ?? { window },
            makeSession: { [self] url, callbackScheme, completionHandler in
                let session = FakeWebAuthenticationSession(
                    url: url,
                    callbackScheme: callbackScheme,
                    completionHandler: completionHandler
                )
                created += 1
                last = session
                configure(session)
                return session
            }
        )
    }
}

/// A value a `@MainActor` closure can set.
@MainActor
final class Box<Value> {
    var value: Value

    init(_ value: Value) {
        self.value = value
    }
}

private func mockSession() -> URLSession {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [OIDCMockURLProtocol.self] + (config.protocolClasses ?? [])
    return URLSession(configuration: config)
}

final class WebAuthenticationSessionLauncherTests: XCTestCase {

    /// Waits for `task`, failing the test instead of hanging when a regression leaves the launch suspended.
    @MainActor
    private func outcome(of task: Task<URL, Error>, timeout: TimeInterval = 30) async -> Result<URL, Error>? {
        let ended = expectation(description: "launch ended")
        let outcome = Box<Result<URL, Error>?>(nil)
        Task {
            do {
                outcome.value = .success(try await task.value)
            } catch {
                outcome.value = .failure(error)
            }
            ended.fulfill()
        }
        await fulfillment(of: [ended], timeout: timeout)
        return outcome.value
    }

    /// The redirect the session completes with is the launch's result.
    @MainActor
    func testReturnsTheRedirectTheSessionCompletesWith() async throws {
        let factory = FakeSessionFactory()
        var session: FakeWebAuthenticationSession?
        factory.configure = { session = $0 }

        let result = try await factory.launcher().launch(authorizeURL: authorizeURL, callbackScheme: "myapp")

        XCTAssertEqual(result, redirect)
        let fake = try XCTUnwrap(session)
        XCTAssertEqual(fake.url, authorizeURL)
        XCTAssertEqual(fake.callbackScheme, "myapp")
        XCTAssertFalse(fake.prefersEphemeralWebBrowserSession)
        XCTAssertEqual(fake.startCount, 1)
        XCTAssertEqual(fake.cancelCount, 0)
    }

    /// A launcher made for private sessions asks for one, and every session gets an anchor provider before it starts.
    @MainActor
    func testAsksForAPrivateSessionWhenConfigured() async throws {
        let factory = FakeSessionFactory()
        var ephemeralAtStart: Bool?
        var hadProviderAtStart = false
        factory.configure = { fake in
            fake.onStart = { started in
                ephemeralAtStart = started.prefersEphemeralWebBrowserSession
                hadProviderAtStart = started.presentationContextProvider != nil
                started.finish(redirect, nil)
            }
        }

        _ = try await factory.launcher(prefersEphemeralWebBrowserSession: true)
            .launch(authorizeURL: authorizeURL, callbackScheme: "myapp")

        XCTAssertEqual(ephemeralAtStart, true)
        XCTAssertTrue(hadProviderAtStart)
    }

    /// A dismissed sheet is a cancelled sign-in, and the launcher doesn't cancel a session the system ended.
    @MainActor
    func testDismissedSheetThrowsCancelled() async throws {
        let factory = FakeSessionFactory()
        var session: FakeWebAuthenticationSession?
        factory.configure = { fake in
            session = fake
            fake.onStart = { $0.finish(nil, ASWebAuthenticationSessionError(.canceledLogin)) }
        }

        do {
            _ = try await factory.launcher().launch(authorizeURL: authorizeURL, callbackScheme: "myapp")
            XCTFail("Expected OIDCError.cancelled")
        } catch OIDCError.cancelled {
            // Expected.
        }
        XCTAssertEqual(session?.cancelCount, 0)
    }

    /// A sheet the system won't show reports why, as iOS does in the background: the completion handler gets the
    /// error, then `start()` returns `false`.
    @MainActor
    func testASheetTheSystemWontShowReportsTheSystemsError() async throws {
        for code in [ASWebAuthenticationSessionError.Code.presentationContextNotProvided, .presentationContextInvalid] {
            let factory = FakeSessionFactory()
            factory.configure = { fake in
                fake.onStart = { $0.finish(nil, ASWebAuthenticationSessionError(code)) }
                fake.startResult = false
            }

            do {
                _ = try await factory.launcher().launch(authorizeURL: authorizeURL, callbackScheme: "myapp")
                XCTFail("Expected OIDCError.callbackError for \(code)")
            } catch let OIDCError.callbackError(detail, cause) {
                XCTAssertTrue(detail.contains("foreground"), detail)
                XCTAssertEqual((cause as? ASWebAuthenticationSessionError)?.code, code)
            }
        }
    }

    /// Any other session error is a callback error that keeps the system's error.
    @MainActor
    func testOtherSessionErrorsAreCallbackErrorsWithTheCause() async throws {
        let factory = FakeSessionFactory()
        let systemError = NSError(domain: "com.example.test", code: 7)
        factory.configure = { fake in
            fake.onStart = { $0.finish(nil, systemError) }
        }

        do {
            _ = try await factory.launcher().launch(authorizeURL: authorizeURL, callbackScheme: "myapp")
            XCTFail("Expected OIDCError.callbackError")
        } catch let error as OIDCError {
            guard case .callbackError(let detail, let cause) = error else {
                return XCTFail("Expected callbackError, got \(error)")
            }
            XCTAssertTrue(detail.contains("sign-in session failed"), detail)
            XCTAssertEqual((cause as NSError?)?.domain, "com.example.test")
            XCTAssertEqual((cause as NSError?)?.code, 7)
            XCTAssertEqual((error.underlyingError as NSError?)?.code, 7)
        }
    }

    /// A completion with neither a redirect nor an error still ends the launch.
    @MainActor
    func testASessionEndingWithNoRedirectAndNoErrorIsACallbackError() async throws {
        let factory = FakeSessionFactory()
        factory.configure = { fake in
            fake.onStart = { $0.finish(nil, nil) }
        }

        do {
            _ = try await factory.launcher().launch(authorizeURL: authorizeURL, callbackScheme: "myapp")
            XCTFail("Expected OIDCError.callbackError")
        } catch let OIDCError.callbackError(_, cause) {
            XCTAssertNil(cause)
        }
    }

    /// A `start()` that fails without calling the completion handler doesn't leave the caller waiting, and a completion
    /// that arrives afterwards is ignored (a second resume would trap).
    @MainActor
    func testAFailedStartEndsTheLaunchAndALateCompletionIsIgnored() async throws {
        let factory = FakeSessionFactory()
        var session: FakeWebAuthenticationSession?
        factory.configure = { fake in
            session = fake
            fake.onStart = { _ in }
            fake.startResult = false
        }

        do {
            _ = try await factory.launcher().launch(authorizeURL: authorizeURL, callbackScheme: "myapp")
            XCTFail("Expected OIDCError.callbackError")
        } catch let OIDCError.callbackError(detail, cause) {
            XCTAssertTrue(detail.contains("couldn't start"), detail)
            XCTAssertNil(cause)
        }

        try XCTUnwrap(session).finish(redirect, nil)
    }

    /// A completion that arrives inside a `start()` that then reports failure still wins.
    @MainActor
    func testACompletionBeforeAFailedStartReturnsTheRedirect() async throws {
        let factory = FakeSessionFactory()
        factory.configure = { $0.startResult = false }

        let result = try await factory.launcher().launch(authorizeURL: authorizeURL, callbackScheme: "myapp")

        XCTAssertEqual(result, redirect)
    }

    /// A completion the system delivers on another thread still returns the redirect.
    @MainActor
    func testACompletionFromAnotherThreadReturnsTheRedirect() async throws {
        let factory = FakeSessionFactory()
        factory.configure = { fake in
            fake.onStart = { $0.finishFromAnotherThread(with: redirect) }
        }

        let result = try await factory.launcher().launch(authorizeURL: authorizeURL, callbackScheme: "myapp")

        XCTAssertEqual(result, redirect)
    }

    /// Completions and cancellations from other threads, racing each other, resume each launch exactly once.
    @MainActor
    func testRacingCompletionsAndCancellationsResumeEachLaunchOnce() async throws {
        let factory = FakeSessionFactory()
        factory.configure = { fake in
            fake.onStart = { $0.finishFromAnotherThread(with: redirect) }
        }
        let launcher = factory.launcher()

        for _ in 0 ..< 500 {
            let task = Task { try await launcher.launch(authorizeURL: authorizeURL, callbackScheme: "myapp") }
            DispatchQueue.global().async { task.cancel() }
            do {
                let result = try await task.value
                XCTAssertEqual(result, redirect)
            } catch is CancellationError {
                // The cancellation won the race.
            }
        }
    }

    /// Cancelling the calling task dismisses the sheet and throws `CancellationError`; the system's late completion is
    /// ignored.
    @MainActor
    func testCancellingTheTaskDismissesTheSheetAndThrowsCancellationError() async throws {
        let factory = FakeSessionFactory()
        let started = expectation(description: "session started")
        var session: FakeWebAuthenticationSession?
        factory.configure = { fake in
            session = fake
            fake.onStart = { _ in started.fulfill() }
        }
        let launcher = factory.launcher()

        let task = Task { try await launcher.launch(authorizeURL: authorizeURL, callbackScheme: "myapp") }
        await fulfillment(of: [started], timeout: 10)
        task.cancel()

        let result = await outcome(of: task)
        guard case .failure(let error) = result, error is CancellationError else {
            return XCTFail("Expected CancellationError, got \(String(describing: result))")
        }
        let fake = try XCTUnwrap(session)
        XCTAssertEqual(fake.cancelCount, 1)
        fake.finish(nil, ASWebAuthenticationSessionError(.canceledLogin))
    }

    /// A task cancelled before the launch shows nothing.
    @MainActor
    func testATaskCancelledBeforeTheLaunchOpensNothing() async throws {
        let factory = FakeSessionFactory()
        let launcher = factory.launcher()

        // The task runs on the main actor, so it can't start before this test awaits it.
        let task = Task { try await launcher.launch(authorizeURL: authorizeURL, callbackScheme: "myapp") }
        task.cancel()

        do {
            _ = try await task.value
            XCTFail("Expected CancellationError")
        } catch is CancellationError {
            // Expected.
        }
        XCTAssertEqual(factory.created, 0)
    }

    /// A task cancelled while the session is being made never starts it.
    @MainActor
    func testATaskCancelledWhileTheSessionIsBeingMadeNeverStartsIt() async throws {
        let factory = FakeSessionFactory()
        var task: Task<URL, Error>?
        var session: FakeWebAuthenticationSession?
        // Runs between begin() and hold(), where a cancel from another thread can land.
        factory.configure = { fake in
            session = fake
            task?.cancel()
        }
        let launcher = factory.launcher()

        task = Task { try await launcher.launch(authorizeURL: authorizeURL, callbackScheme: "myapp") }

        do {
            _ = try await task?.value
            XCTFail("Expected CancellationError")
        } catch is CancellationError {
            // Expected.
        }
        XCTAssertEqual(session?.startCount, 0)
    }

    /// The launcher keeps the session and its anchor provider until the launch ends, then lets both go.
    @MainActor
    func testKeepsTheSessionAndItsAnchorProviderUntilTheLaunchEnds() async throws {
        let factory = FakeSessionFactory()
        let started = expectation(description: "session started")
        factory.configure = { fake in
            fake.onStart = { _ in started.fulfill() }
        }
        let launcher = factory.launcher()

        let task = Task { try await launcher.launch(authorizeURL: authorizeURL, callbackScheme: "myapp") }
        await fulfillment(of: [started], timeout: 10)

        guard factory.last != nil else {
            task.cancel()
            return XCTFail("The launcher let the session go before the launch ended")
        }
        XCTAssertNotNil(factory.last?.presentationContextProvider)
        factory.last?.finish(redirect, nil)

        let result = await outcome(of: task)
        XCTAssertEqual(try result?.get(), redirect)
        XCTAssertNil(factory.last)
    }

    /// One sign-in opens at a time, across launchers: a second one while a sheet is open fails before anything opens,
    /// and the next one after it ends opens.
    @MainActor
    func testASecondSignInWhileOneIsOpenFailsBeforeOpening() async throws {
        let factory = FakeSessionFactory()
        let started = expectation(description: "first session started")
        var made = 0
        // Held after it ends, as the system can hold its session.
        var first: FakeWebAuthenticationSession?
        factory.configure = { fake in
            made += 1
            if made == 1 {
                first = fake
                fake.onStart = { _ in started.fulfill() }
            }
        }

        let launcher = factory.launcher()
        let firstLaunch = Task { try await launcher.launch(authorizeURL: authorizeURL, callbackScheme: "myapp") }
        await fulfillment(of: [started], timeout: 10)

        do {
            _ = try await factory.launcher().launch(authorizeURL: authorizeURL, callbackScheme: "myapp")
            XCTFail("Expected OIDCError.callbackError")
        } catch let OIDCError.callbackError(detail, cause) {
            XCTAssertTrue(detail.contains("already open"), detail)
            XCTAssertNil(cause)
        }
        XCTAssertEqual(factory.created, 1)

        first?.finish(redirect, nil)
        let firstResult = await outcome(of: firstLaunch)
        XCTAssertEqual(try firstResult?.get(), redirect)

        let next = try await factory.launcher().launch(authorizeURL: authorizeURL, callbackScheme: "myapp")
        XCTAssertEqual(next, redirect)
        XCTAssertNotNil(first)
    }

    /// The sheet opens over the window the app names, and the app is asked for it once.
    @MainActor
    func testTheSheetOpensOverTheAppsAnchor() async throws {
        let window = ASPresentationAnchor()
        let asking = ASWebAuthenticationSession(url: authorizeURL, callbackURLScheme: "myapp") { _, _ in }
        let factory = FakeSessionFactory()
        let asked = Box(0)
        var anchor: ASPresentationAnchor?
        factory.configure = { fake in
            fake.onStart = { started in
                anchor = started.presentationContextProvider?.presentationAnchor(for: asking)
                started.finish(redirect, nil)
            }
        }
        let launcher = factory.launcher(presentationAnchor: {
            asked.value += 1
            return window
        })

        _ = try await launcher.launch(authorizeURL: authorizeURL, callbackScheme: "myapp")

        XCTAssertTrue(anchor === window)
        XCTAssertEqual(asked.value, 1)
    }

    /// With no window, an iOS sign-in fails before anything opens, since the sheet would never appear. On macOS the
    /// default browser shows its own window, so the sign-in still opens.
    @MainActor
    func testASignInWithNoWindowFailsFirstOnIOSAndStillOpensOnMacOS() async throws {
        let factory = FakeSessionFactory()
        let launcher = factory.launcher(presentationAnchor: { nil }, keyWindow: { nil })

        #if os(macOS) || targetEnvironment(macCatalyst)
        let result = try await launcher.launch(authorizeURL: authorizeURL, callbackScheme: "myapp")
        XCTAssertEqual(result, redirect)
        XCTAssertEqual(factory.created, 1)
        #else
        do {
            _ = try await launcher.launch(authorizeURL: authorizeURL, callbackScheme: "myapp")
            XCTFail("Expected OIDCError.callbackError")
        } catch let OIDCError.callbackError(detail, cause) {
            XCTAssertTrue(detail.contains("presentationAnchor"), detail)
            XCTAssertNil(cause)
        }
        XCTAssertEqual(factory.created, 0)
        #endif
    }

    /// Relay targets `ASWebAuthenticationSession` can't catch are refused before anything opens.
    @MainActor
    func testRefusesARelayTargetWithoutACustomScheme() async throws {
        let factory = FakeSessionFactory()
        let launcher = factory.launcher()

        for scheme in ["", "http", "HTTPS", "my app", "myapp://", "1app", "-app", "app/auth", "äpp"] {
            do {
                _ = try await launcher.launch(authorizeURL: authorizeURL, callbackScheme: scheme)
                XCTFail("Expected OIDCError.callbackError for \"\(scheme)\"")
            } catch let OIDCError.callbackError(detail, cause) {
                XCTAssertTrue(detail.contains("relayTo"), detail)
                XCTAssertNil(cause)
            }
        }
        XCTAssertEqual(factory.created, 0)
    }

    /// Custom schemes are accepted whatever their case or punctuation.
    func testAcceptsCustomSchemes() {
        for scheme in ["myapp", "MyApp", "com.example.app", "x-app+v1.2", "a"] {
            XCTAssertTrue(WebAuthenticationSessionLauncher.isCustomScheme(scheme), scheme)
        }
    }

    /// Authorize URLs that aren't `http` or `https` are refused before anything opens; an `HTTPS` URL in capitals isn't.
    @MainActor
    func testRefusesAnAuthorizeURLThatIsNotHTTP() async throws {
        let factory = FakeSessionFactory()
        let launcher = factory.launcher()

        for string in ["javascript:alert(1)", "ftp://example.com/authorize", "myapp://authorize", "file:///etc/hosts"] {
            let url = try XCTUnwrap(URL(string: string))
            do {
                _ = try await launcher.launch(authorizeURL: url, callbackScheme: "myapp")
                XCTFail("Expected OIDCError.invalidAuthorizeURL for \(string)")
            } catch let OIDCError.invalidAuthorizeURL(refused) {
                XCTAssertEqual(refused, string)
            }
        }
        XCTAssertEqual(factory.created, 0)
        XCTAssertNoThrow(try WebAuthenticationSessionLauncher.validate(
            authorizeURL: try XCTUnwrap(URL(string: "HTTPS://idp.example.com/authorize")),
            callbackScheme: "myapp"
        ))
    }

    // MARK: - With OIDCClient

    /// Signing in opens the sheet on the full authorize URL and exchanges the code the backend relays back.
    @MainActor
    func testSignInOpensTheSheetAndExchangesTheRelayedCode() async throws {
        OIDCMockURLProtocol.reset()
        defer { OIDCMockURLProtocol.reset() }
        OIDCMockURLProtocol.handler = { request in
            let url = try XCTUnwrap(request.url)
            // The server signs a state envelope carrying the request's csrf, which sign-in checks.
            let csrf = requestJSON(request)["csrf"] as? String ?? ""
            let payload = try JSONSerialization.data(withJSONObject: ["v": 1, "csrf": csrf])
            let state = payload.base64EncodedString()
                .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "") + ".sig"
            let body: [String: Any] = url.path.hasSuffix("/authorize-params/google")
                ? ["authorizeUrl": "https://idp.example.com/authorize", "clientId": "cid", "scopes": ["openid"], "state": state]
                : ["user": ["userId": "u1", "username": "dave"]]
            let response = try XCTUnwrap(HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil))
            return (response, try JSONSerialization.data(withJSONObject: body))
        }
        let oidc = makeOIDCClient()
        let factory = FakeSessionFactory()
        var session: FakeWebAuthenticationSession?
        factory.configure = { fake in
            session = fake
            fake.onStart = { fake in
                // The relay carries back the state the sheet was opened with.
                let state = URLComponents(url: fake.url, resolvingAgainstBaseURL: false)?
                    .queryItems?.first { $0.name == "state" }?.value ?? ""
                fake.finish(URL(string: "nativebindings://auth?code=c&state=\(state)"), nil)
            }
        }

        let user = try await oidc.signIn(provider: "google", relayTo: "nativebindings://auth", launcher: factory.launcher())

        XCTAssertEqual(user.userId, "u1")
        let fake = try XCTUnwrap(session)
        XCTAssertEqual(fake.callbackScheme, "nativebindings")
        let opened = try XCTUnwrap(URLComponents(url: fake.url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(opened.host, "idp.example.com")
        XCTAssertEqual(opened.queryItems?.first { $0.name == "state" }?.value?.hasSuffix(".sig"), true, "the server's signed state")
        XCTAssertEqual(
            OIDCMockURLProtocol.requests.compactMap { $0.url?.path },
            ["/cdk-blocks/auth/authorize-params/google", "/cdk-blocks/auth/exchange"]
        )
    }

    /// Dismissing the sheet ends sign-in with `OIDCError.cancelled` before the exchange.
    @MainActor
    func testDismissingTheSheetEndsSignInBeforeTheExchange() async throws {
        OIDCMockURLProtocol.reset()
        defer { OIDCMockURLProtocol.reset() }
        OIDCMockURLProtocol.handler = { request in
            let url = try XCTUnwrap(request.url)
            let body: [String: Any] = [
                "authorizeUrl": "https://idp.example.com/authorize", "clientId": "cid", "scopes": ["openid"], "state": "signed-state"
            ]
            let response = try XCTUnwrap(HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil))
            return (response, try JSONSerialization.data(withJSONObject: body))
        }
        let oidc = makeOIDCClient()
        let factory = FakeSessionFactory()
        factory.configure = { fake in
            fake.onStart = { $0.finish(nil, ASWebAuthenticationSessionError(.canceledLogin)) }
        }

        do {
            _ = try await oidc.signIn(provider: "google", relayTo: "nativebindings://auth", launcher: factory.launcher())
            XCTFail("Expected OIDCError.cancelled")
        } catch OIDCError.cancelled {
            // Expected.
        }
        XCTAssertEqual(OIDCMockURLProtocol.requests.compactMap { $0.url?.path }, ["/cdk-blocks/auth/authorize-params/google"])
    }

    private func makeOIDCClient() -> OIDCClient<String> {
        let blocksClient = BlocksClient(url: "https://api.example.com/cdk-blocks/api", session: mockSession())
        return OIDCClient<String>(
            exchangePath: "/cdk-blocks/auth/exchange",
            refreshPath: "/cdk-blocks/auth/exchange/refresh",
            signOutPath: "/cdk-blocks/auth/signout",
            providers: ["google"],
            providerConfigs: [:],
            baseUrl: blocksClient.baseUrl,
            client: blocksClient
        )
    }
}

/// Compiles only while `signIn(provider:relayTo:)` needs no launcher argument.
private func signInWithTheSystemSheet(_ oidc: OIDCClient<String>) async throws -> OIDCUser {
    try await oidc.signIn(provider: "google", relayTo: "myapp://auth")
}
#endif
