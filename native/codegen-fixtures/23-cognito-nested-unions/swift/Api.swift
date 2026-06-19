import Foundation
import BlocksRuntime

public class Api {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `api.cognitoConfirmSignIn`.
    public func cognitoConfirmSignIn(session: String, challengeResponse: String) async throws -> CognitoConfirmSignIn.Result {
        let request = BlocksRequest(method: "api.cognitoConfirmSignIn", params: [session, challengeResponse], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.cognitoConfirmSignIn") }
        return try JSONDecoder().decode(CognitoConfirmSignIn.Result.self, from: result)
    }

    /// Calls `api.cognitoSignIn`.
    public func cognitoSignIn(username: String, password: String) async throws -> CognitoSignIn.Result {
        let request = BlocksRequest(method: "api.cognitoSignIn", params: [username, password], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.cognitoSignIn") }
        return try JSONDecoder().decode(CognitoSignIn.Result.self, from: result)
    }

    public enum CognitoConfirmSignIn {

        public struct ContinueSignIn: Codable {
            public let nextStep: NextStep

            public struct ConfirmSignInWithSmsCode: Codable {
                public let codeDeliveryDetails: CodeDeliveryDetails
                public let session: String
            }

            public struct ConfirmSignInWithTotpCode: Codable {
                public let session: String
            }

            public struct ConfirmSignInWithEmailCode: Codable {
                public let codeDeliveryDetails: CodeDeliveryDetails
                public let session: String
            }

            public struct ContinueSignInWithMfaSelection: Codable {
                public let allowedMFATypes: [AllowedMFAType]
                public let session: String

                public enum AllowedMFAType: String, Codable {
                    case sms = "SMS"
                    case totp = "TOTP"
                    case email = "EMAIL"
                }
            }

            public struct ContinueSignInWithMfaSetupSelection: Codable {
                public let allowedMFATypes: [AllowedMFAType]
                public let session: String

                public enum AllowedMFAType: String, Codable {
                    case totp = "TOTP"
                    case email = "EMAIL"
                }
            }

            public struct ContinueSignInWithTotpSetup: Codable {
                public let session: String
                public let sharedSecret: String
            }

            public struct ContinueSignInWithEmailSetup: Codable {
                public let session: String
            }

            public struct ConfirmSignInWithNewPasswordRequired: Codable {
                public let requiredAttributes: [String]?
                public let session: String

                enum CodingKeys: String, CodingKey {
                    case requiredAttributes
                    case session
                }

                public func encode(to encoder: Encoder) throws {
                    var c = encoder.container(keyedBy: CodingKeys.self)
                    try c.encodeIfPresent(self.requiredAttributes, forKey: .requiredAttributes)
                    try c.encode(self.session, forKey: .session)
                }
            }

            public struct ContinueSignInWithFirstFactorSelection: Codable {
                public let availableChallenges: [AvailableChallenge]
                public let session: String

                public enum AvailableChallenge: String, Codable {
                    case password = "PASSWORD"
                    case emailOtp = "EMAIL_OTP"
                    case smsOtp = "SMS_OTP"
                    case webAuthn = "WEB_AUTHN"
                }
            }

            public struct ConfirmSignInWithPassword: Codable {
                public let session: String
            }

            public struct ConfirmSignInWithFirstFactorEmailOtp: Codable {
                public let codeDeliveryDetails: CodeDeliveryDetails
                public let session: String
            }

            public struct ConfirmSignInWithFirstFactorSmsOtp: Codable {
                public let codeDeliveryDetails: CodeDeliveryDetails
                public let session: String
            }

            public struct ConfirmSignInWithWebAuthn: Codable {
                public let credentialRequestOptions: String
                public let session: String
            }

            public struct ConfirmSignUp: Codable {
                public let codeDeliveryDetails: CodeDeliveryDetails?

                enum CodingKeys: String, CodingKey {
                    case codeDeliveryDetails
                }

                public func encode(to encoder: Encoder) throws {
                    var c = encoder.container(keyedBy: CodingKeys.self)
                    try c.encodeIfPresent(self.codeDeliveryDetails, forKey: .codeDeliveryDetails)
                }
            }

            public enum NextStep: Codable {
                case confirmSignInWithSmsCode(ConfirmSignInWithSmsCode)
                case confirmSignInWithTotpCode(ConfirmSignInWithTotpCode)
                case confirmSignInWithEmailCode(ConfirmSignInWithEmailCode)
                case continueSignInWithMfaSelection(ContinueSignInWithMfaSelection)
                case continueSignInWithMfaSetupSelection(ContinueSignInWithMfaSetupSelection)
                case continueSignInWithTotpSetup(ContinueSignInWithTotpSetup)
                case continueSignInWithEmailSetup(ContinueSignInWithEmailSetup)
                case confirmSignInWithNewPasswordRequired(ConfirmSignInWithNewPasswordRequired)
                case continueSignInWithFirstFactorSelection(ContinueSignInWithFirstFactorSelection)
                case confirmSignInWithPassword(ConfirmSignInWithPassword)
                case confirmSignInWithFirstFactorEmailOtp(ConfirmSignInWithFirstFactorEmailOtp)
                case confirmSignInWithFirstFactorSmsOtp(ConfirmSignInWithFirstFactorSmsOtp)
                case confirmSignInWithWebAuthn(ConfirmSignInWithWebAuthn)
                case resetPassword
                case confirmSignUp(ConfirmSignUp)

                enum CodingKeys: String, CodingKey {
                    case name
                }

                public func encode(to encoder: Encoder) throws {
                    var container = encoder.container(keyedBy: CodingKeys.self)
                    switch self {
                    case .confirmSignInWithSmsCode(let params):
                        try container.encode("CONFIRM_SIGN_IN_WITH_SMS_CODE", forKey: .name)
                        try params.encode(to: encoder)
                    case .confirmSignInWithTotpCode(let params):
                        try container.encode("CONFIRM_SIGN_IN_WITH_TOTP_CODE", forKey: .name)
                        try params.encode(to: encoder)
                    case .confirmSignInWithEmailCode(let params):
                        try container.encode("CONFIRM_SIGN_IN_WITH_EMAIL_CODE", forKey: .name)
                        try params.encode(to: encoder)
                    case .continueSignInWithMfaSelection(let params):
                        try container.encode("CONTINUE_SIGN_IN_WITH_MFA_SELECTION", forKey: .name)
                        try params.encode(to: encoder)
                    case .continueSignInWithMfaSetupSelection(let params):
                        try container.encode("CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION", forKey: .name)
                        try params.encode(to: encoder)
                    case .continueSignInWithTotpSetup(let params):
                        try container.encode("CONTINUE_SIGN_IN_WITH_TOTP_SETUP", forKey: .name)
                        try params.encode(to: encoder)
                    case .continueSignInWithEmailSetup(let params):
                        try container.encode("CONTINUE_SIGN_IN_WITH_EMAIL_SETUP", forKey: .name)
                        try params.encode(to: encoder)
                    case .confirmSignInWithNewPasswordRequired(let params):
                        try container.encode("CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED", forKey: .name)
                        try params.encode(to: encoder)
                    case .continueSignInWithFirstFactorSelection(let params):
                        try container.encode("CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION", forKey: .name)
                        try params.encode(to: encoder)
                    case .confirmSignInWithPassword(let params):
                        try container.encode("CONFIRM_SIGN_IN_WITH_PASSWORD", forKey: .name)
                        try params.encode(to: encoder)
                    case .confirmSignInWithFirstFactorEmailOtp(let params):
                        try container.encode("CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP", forKey: .name)
                        try params.encode(to: encoder)
                    case .confirmSignInWithFirstFactorSmsOtp(let params):
                        try container.encode("CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP", forKey: .name)
                        try params.encode(to: encoder)
                    case .confirmSignInWithWebAuthn(let params):
                        try container.encode("CONFIRM_SIGN_IN_WITH_WEB_AUTHN", forKey: .name)
                        try params.encode(to: encoder)
                    case .resetPassword:
                        try container.encode("RESET_PASSWORD", forKey: .name)
                    case .confirmSignUp(let params):
                        try container.encode("CONFIRM_SIGN_UP", forKey: .name)
                        try params.encode(to: encoder)
                    }
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: CodingKeys.self)
                    let disc = try container.decode(String.self, forKey: .name)
                    switch disc {
                    case "CONFIRM_SIGN_IN_WITH_SMS_CODE": self = .confirmSignInWithSmsCode(try ConfirmSignInWithSmsCode(from: decoder))
                    case "CONFIRM_SIGN_IN_WITH_TOTP_CODE": self = .confirmSignInWithTotpCode(try ConfirmSignInWithTotpCode(from: decoder))
                    case "CONFIRM_SIGN_IN_WITH_EMAIL_CODE": self = .confirmSignInWithEmailCode(try ConfirmSignInWithEmailCode(from: decoder))
                    case "CONTINUE_SIGN_IN_WITH_MFA_SELECTION": self = .continueSignInWithMfaSelection(try ContinueSignInWithMfaSelection(from: decoder))
                    case "CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION": self = .continueSignInWithMfaSetupSelection(try ContinueSignInWithMfaSetupSelection(from: decoder))
                    case "CONTINUE_SIGN_IN_WITH_TOTP_SETUP": self = .continueSignInWithTotpSetup(try ContinueSignInWithTotpSetup(from: decoder))
                    case "CONTINUE_SIGN_IN_WITH_EMAIL_SETUP": self = .continueSignInWithEmailSetup(try ContinueSignInWithEmailSetup(from: decoder))
                    case "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED": self = .confirmSignInWithNewPasswordRequired(try ConfirmSignInWithNewPasswordRequired(from: decoder))
                    case "CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION": self = .continueSignInWithFirstFactorSelection(try ContinueSignInWithFirstFactorSelection(from: decoder))
                    case "CONFIRM_SIGN_IN_WITH_PASSWORD": self = .confirmSignInWithPassword(try ConfirmSignInWithPassword(from: decoder))
                    case "CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP": self = .confirmSignInWithFirstFactorEmailOtp(try ConfirmSignInWithFirstFactorEmailOtp(from: decoder))
                    case "CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP": self = .confirmSignInWithFirstFactorSmsOtp(try ConfirmSignInWithFirstFactorSmsOtp(from: decoder))
                    case "CONFIRM_SIGN_IN_WITH_WEB_AUTHN": self = .confirmSignInWithWebAuthn(try ConfirmSignInWithWebAuthn(from: decoder))
                    case "RESET_PASSWORD": self = .resetPassword
                    case "CONFIRM_SIGN_UP": self = .confirmSignUp(try ConfirmSignUp(from: decoder))
                    default:
                        throw DecodingError.dataCorruptedError(forKey: .name, in: container, debugDescription: "Unknown value: \(disc)")
                    }
                }
            }
        }

        public struct SignedIn: Codable {
            public let user: CognitoUser
        }

        public enum Result: Codable {
            case continueSignIn(ContinueSignIn)
            case signedIn(SignedIn)

            enum CodingKeys: String, CodingKey {
                case status
            }

            public func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                switch self {
                case .continueSignIn(let params):
                    try container.encode("continueSignIn", forKey: .status)
                    try params.encode(to: encoder)
                case .signedIn(let params):
                    try container.encode("signedIn", forKey: .status)
                    try params.encode(to: encoder)
                }
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                let disc = try container.decode(String.self, forKey: .status)
                switch disc {
                case "continueSignIn": self = .continueSignIn(try ContinueSignIn(from: decoder))
                case "signedIn": self = .signedIn(try SignedIn(from: decoder))
                default:
                    throw DecodingError.dataCorruptedError(forKey: .status, in: container, debugDescription: "Unknown value: \(disc)")
                }
            }
        }
    }

    public enum CognitoSignIn {

        public struct ContinueSignIn: Codable {
            public let nextStep: NextStep

            public struct ConfirmSignInWithSmsCode: Codable {
                public let codeDeliveryDetails: CodeDeliveryDetails
                public let session: String
            }

            public struct ConfirmSignInWithTotpCode: Codable {
                public let session: String
            }

            public struct ConfirmSignInWithEmailCode: Codable {
                public let codeDeliveryDetails: CodeDeliveryDetails
                public let session: String
            }

            public struct ContinueSignInWithMfaSelection: Codable {
                public let allowedMFATypes: [AllowedMFAType]
                public let session: String

                public enum AllowedMFAType: String, Codable {
                    case sms = "SMS"
                    case totp = "TOTP"
                    case email = "EMAIL"
                }
            }

            public struct ContinueSignInWithMfaSetupSelection: Codable {
                public let allowedMFATypes: [AllowedMFAType]
                public let session: String

                public enum AllowedMFAType: String, Codable {
                    case totp = "TOTP"
                    case email = "EMAIL"
                }
            }

            public struct ContinueSignInWithTotpSetup: Codable {
                public let session: String
                public let sharedSecret: String
            }

            public struct ContinueSignInWithEmailSetup: Codable {
                public let session: String
            }

            public struct ConfirmSignInWithNewPasswordRequired: Codable {
                public let requiredAttributes: [String]?
                public let session: String

                enum CodingKeys: String, CodingKey {
                    case requiredAttributes
                    case session
                }

                public func encode(to encoder: Encoder) throws {
                    var c = encoder.container(keyedBy: CodingKeys.self)
                    try c.encodeIfPresent(self.requiredAttributes, forKey: .requiredAttributes)
                    try c.encode(self.session, forKey: .session)
                }
            }

            public struct ContinueSignInWithFirstFactorSelection: Codable {
                public let availableChallenges: [AvailableChallenge]
                public let session: String

                public enum AvailableChallenge: String, Codable {
                    case password = "PASSWORD"
                    case emailOtp = "EMAIL_OTP"
                    case smsOtp = "SMS_OTP"
                    case webAuthn = "WEB_AUTHN"
                }
            }

            public struct ConfirmSignInWithPassword: Codable {
                public let session: String
            }

            public struct ConfirmSignInWithFirstFactorEmailOtp: Codable {
                public let codeDeliveryDetails: CodeDeliveryDetails
                public let session: String
            }

            public struct ConfirmSignInWithFirstFactorSmsOtp: Codable {
                public let codeDeliveryDetails: CodeDeliveryDetails
                public let session: String
            }

            public struct ConfirmSignInWithWebAuthn: Codable {
                public let credentialRequestOptions: String
                public let session: String
            }

            public struct ConfirmSignUp: Codable {
                public let codeDeliveryDetails: CodeDeliveryDetails?

                enum CodingKeys: String, CodingKey {
                    case codeDeliveryDetails
                }

                public func encode(to encoder: Encoder) throws {
                    var c = encoder.container(keyedBy: CodingKeys.self)
                    try c.encodeIfPresent(self.codeDeliveryDetails, forKey: .codeDeliveryDetails)
                }
            }

            public enum NextStep: Codable {
                case confirmSignInWithSmsCode(ConfirmSignInWithSmsCode)
                case confirmSignInWithTotpCode(ConfirmSignInWithTotpCode)
                case confirmSignInWithEmailCode(ConfirmSignInWithEmailCode)
                case continueSignInWithMfaSelection(ContinueSignInWithMfaSelection)
                case continueSignInWithMfaSetupSelection(ContinueSignInWithMfaSetupSelection)
                case continueSignInWithTotpSetup(ContinueSignInWithTotpSetup)
                case continueSignInWithEmailSetup(ContinueSignInWithEmailSetup)
                case confirmSignInWithNewPasswordRequired(ConfirmSignInWithNewPasswordRequired)
                case continueSignInWithFirstFactorSelection(ContinueSignInWithFirstFactorSelection)
                case confirmSignInWithPassword(ConfirmSignInWithPassword)
                case confirmSignInWithFirstFactorEmailOtp(ConfirmSignInWithFirstFactorEmailOtp)
                case confirmSignInWithFirstFactorSmsOtp(ConfirmSignInWithFirstFactorSmsOtp)
                case confirmSignInWithWebAuthn(ConfirmSignInWithWebAuthn)
                case resetPassword
                case confirmSignUp(ConfirmSignUp)

                enum CodingKeys: String, CodingKey {
                    case name
                }

                public func encode(to encoder: Encoder) throws {
                    var container = encoder.container(keyedBy: CodingKeys.self)
                    switch self {
                    case .confirmSignInWithSmsCode(let params):
                        try container.encode("CONFIRM_SIGN_IN_WITH_SMS_CODE", forKey: .name)
                        try params.encode(to: encoder)
                    case .confirmSignInWithTotpCode(let params):
                        try container.encode("CONFIRM_SIGN_IN_WITH_TOTP_CODE", forKey: .name)
                        try params.encode(to: encoder)
                    case .confirmSignInWithEmailCode(let params):
                        try container.encode("CONFIRM_SIGN_IN_WITH_EMAIL_CODE", forKey: .name)
                        try params.encode(to: encoder)
                    case .continueSignInWithMfaSelection(let params):
                        try container.encode("CONTINUE_SIGN_IN_WITH_MFA_SELECTION", forKey: .name)
                        try params.encode(to: encoder)
                    case .continueSignInWithMfaSetupSelection(let params):
                        try container.encode("CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION", forKey: .name)
                        try params.encode(to: encoder)
                    case .continueSignInWithTotpSetup(let params):
                        try container.encode("CONTINUE_SIGN_IN_WITH_TOTP_SETUP", forKey: .name)
                        try params.encode(to: encoder)
                    case .continueSignInWithEmailSetup(let params):
                        try container.encode("CONTINUE_SIGN_IN_WITH_EMAIL_SETUP", forKey: .name)
                        try params.encode(to: encoder)
                    case .confirmSignInWithNewPasswordRequired(let params):
                        try container.encode("CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED", forKey: .name)
                        try params.encode(to: encoder)
                    case .continueSignInWithFirstFactorSelection(let params):
                        try container.encode("CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION", forKey: .name)
                        try params.encode(to: encoder)
                    case .confirmSignInWithPassword(let params):
                        try container.encode("CONFIRM_SIGN_IN_WITH_PASSWORD", forKey: .name)
                        try params.encode(to: encoder)
                    case .confirmSignInWithFirstFactorEmailOtp(let params):
                        try container.encode("CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP", forKey: .name)
                        try params.encode(to: encoder)
                    case .confirmSignInWithFirstFactorSmsOtp(let params):
                        try container.encode("CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP", forKey: .name)
                        try params.encode(to: encoder)
                    case .confirmSignInWithWebAuthn(let params):
                        try container.encode("CONFIRM_SIGN_IN_WITH_WEB_AUTHN", forKey: .name)
                        try params.encode(to: encoder)
                    case .resetPassword:
                        try container.encode("RESET_PASSWORD", forKey: .name)
                    case .confirmSignUp(let params):
                        try container.encode("CONFIRM_SIGN_UP", forKey: .name)
                        try params.encode(to: encoder)
                    }
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: CodingKeys.self)
                    let disc = try container.decode(String.self, forKey: .name)
                    switch disc {
                    case "CONFIRM_SIGN_IN_WITH_SMS_CODE": self = .confirmSignInWithSmsCode(try ConfirmSignInWithSmsCode(from: decoder))
                    case "CONFIRM_SIGN_IN_WITH_TOTP_CODE": self = .confirmSignInWithTotpCode(try ConfirmSignInWithTotpCode(from: decoder))
                    case "CONFIRM_SIGN_IN_WITH_EMAIL_CODE": self = .confirmSignInWithEmailCode(try ConfirmSignInWithEmailCode(from: decoder))
                    case "CONTINUE_SIGN_IN_WITH_MFA_SELECTION": self = .continueSignInWithMfaSelection(try ContinueSignInWithMfaSelection(from: decoder))
                    case "CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION": self = .continueSignInWithMfaSetupSelection(try ContinueSignInWithMfaSetupSelection(from: decoder))
                    case "CONTINUE_SIGN_IN_WITH_TOTP_SETUP": self = .continueSignInWithTotpSetup(try ContinueSignInWithTotpSetup(from: decoder))
                    case "CONTINUE_SIGN_IN_WITH_EMAIL_SETUP": self = .continueSignInWithEmailSetup(try ContinueSignInWithEmailSetup(from: decoder))
                    case "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED": self = .confirmSignInWithNewPasswordRequired(try ConfirmSignInWithNewPasswordRequired(from: decoder))
                    case "CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION": self = .continueSignInWithFirstFactorSelection(try ContinueSignInWithFirstFactorSelection(from: decoder))
                    case "CONFIRM_SIGN_IN_WITH_PASSWORD": self = .confirmSignInWithPassword(try ConfirmSignInWithPassword(from: decoder))
                    case "CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP": self = .confirmSignInWithFirstFactorEmailOtp(try ConfirmSignInWithFirstFactorEmailOtp(from: decoder))
                    case "CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP": self = .confirmSignInWithFirstFactorSmsOtp(try ConfirmSignInWithFirstFactorSmsOtp(from: decoder))
                    case "CONFIRM_SIGN_IN_WITH_WEB_AUTHN": self = .confirmSignInWithWebAuthn(try ConfirmSignInWithWebAuthn(from: decoder))
                    case "RESET_PASSWORD": self = .resetPassword
                    case "CONFIRM_SIGN_UP": self = .confirmSignUp(try ConfirmSignUp(from: decoder))
                    default:
                        throw DecodingError.dataCorruptedError(forKey: .name, in: container, debugDescription: "Unknown value: \(disc)")
                    }
                }
            }
        }

        public struct SignedIn: Codable {
            public let user: CognitoUser
        }

        public enum Result: Codable {
            case continueSignIn(ContinueSignIn)
            case signedIn(SignedIn)

            enum CodingKeys: String, CodingKey {
                case status
            }

            public func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                switch self {
                case .continueSignIn(let params):
                    try container.encode("continueSignIn", forKey: .status)
                    try params.encode(to: encoder)
                case .signedIn(let params):
                    try container.encode("signedIn", forKey: .status)
                    try params.encode(to: encoder)
                }
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                let disc = try container.decode(String.self, forKey: .status)
                switch disc {
                case "continueSignIn": self = .continueSignIn(try ContinueSignIn(from: decoder))
                case "signedIn": self = .signedIn(try SignedIn(from: decoder))
                default:
                    throw DecodingError.dataCorruptedError(forKey: .status, in: container, debugDescription: "Unknown value: \(disc)")
                }
            }
        }
    }
}


// MARK: - Servers

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}