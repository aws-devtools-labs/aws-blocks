import Foundation


public nonisolated enum MfaChallengeAction: String, Codable, Sendable {
    case mfa
}

public nonisolated struct MfaChallenge: Codable, Sendable {
    public let action: MfaChallengeAction
    public let code: String
    public let session: String

    public init(action: MfaChallengeAction, code: String, session: String) {
        self.action = action
        self.code = code
        self.session = session
    }
}