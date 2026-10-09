import Foundation


public enum MfaChallengeAction: String, Codable {
    case mfa
}

public struct MfaChallenge: Codable {
    public let action: MfaChallengeAction
    public let code: String
    public let session: String

    public init(action: MfaChallengeAction, code: String, session: String) {
        self.action = action
        self.code = code
        self.session = session
    }
}