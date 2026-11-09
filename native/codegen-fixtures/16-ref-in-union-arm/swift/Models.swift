import Foundation


public nonisolated enum MfaChallengeAction: String, Codable {
    case mfa
}

public nonisolated struct MfaChallenge: Codable {
    public let action: MfaChallengeAction
    public let code: String
    public let session: String
}