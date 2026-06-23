//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest

// swiftlint:disable nesting
/// Runtime decode coverage for status-discriminated result unions, including a
/// nested discriminated union in an arm — the shape the Cognito `signIn` /
/// `confirmSignIn` RPC methods produce.
///
/// The types below mirror a representative slice of the generated golden
/// `native/codegen-fixtures/23-cognito-nested-unions/swift/Api.swift`
/// (`CognitoSignIn.Result` + a couple of its nested `NextStep` arms). The
/// golden-file test (`GoldenFileTests`) guards that the generator *emits*
/// exactly that code; this test guards that the emitted shape *behaves*
/// correctly at runtime — discriminator routing at BOTH the outer (`status`)
/// and nested (`name`) levels, a nested enum field, round-trip, and a clear
/// error on an unknown discriminant. If the generator output changes,
/// regenerate the golden and update this mirror.
final class StatusDiscriminatorDecodeTests: XCTestCase {

    struct CognitoUser: Codable {
        let userId: String
        let username: String
        let userSub: String
        let groups: [String]
    }

    enum CognitoSignIn {
        struct SignedIn: Codable {
            let user: CognitoUser
        }

        struct ContinueSignIn: Codable {
            let nextStep: NextStep

            // swiftlint:disable:next type_name
            struct Confirm_Sign_In_With_Totp_Code: Codable {
                let session: String
            }

            // swiftlint:disable:next type_name
            struct Continue_Sign_In_With_Mfa_Selection: Codable {
                let allowedMFATypes: [AllowedMFAType]
                let session: String

                enum AllowedMFAType: String, Codable {
                    case sMS = "SMS"
                    case tOTP = "TOTP"
                    case eMAIL = "EMAIL"
                }
            }

            // Nested discriminated union on `name` (representative 2-arm slice).
            enum NextStep: Codable {
                case confirm_Sign_In_With_Totp_Code(Confirm_Sign_In_With_Totp_Code) // swiftlint:disable:this identifier_name
                case continue_Sign_In_With_Mfa_Selection(Continue_Sign_In_With_Mfa_Selection) // swiftlint:disable:this identifier_name

                enum CodingKeys: String, CodingKey { case name }

                func encode(to encoder: Encoder) throws {
                    var container = encoder.container(keyedBy: CodingKeys.self)
                    switch self {
                    case .confirm_Sign_In_With_Totp_Code(let payload):
                        try container.encode("CONFIRM_SIGN_IN_WITH_TOTP_CODE", forKey: .name)
                        try payload.encode(to: encoder)
                    case .continue_Sign_In_With_Mfa_Selection(let payload):
                        try container.encode("CONTINUE_SIGN_IN_WITH_MFA_SELECTION", forKey: .name)
                        try payload.encode(to: encoder)
                    }
                }

                init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: CodingKeys.self)
                    switch try container.decode(String.self, forKey: .name) {
                    case "CONFIRM_SIGN_IN_WITH_TOTP_CODE":
                        self = .confirm_Sign_In_With_Totp_Code(try Confirm_Sign_In_With_Totp_Code(from: decoder))
                    case "CONTINUE_SIGN_IN_WITH_MFA_SELECTION":
                        self = .continue_Sign_In_With_Mfa_Selection(try Continue_Sign_In_With_Mfa_Selection(from: decoder))
                    case let other:
                        throw DecodingError.dataCorruptedError(forKey: .name, in: container, debugDescription: "Unknown value: \(other)")
                    }
                }
            }
        }

        enum Result: Codable {
            case continueSignIn(ContinueSignIn)
            case signedIn(SignedIn)

            enum CodingKeys: String, CodingKey { case status }

            func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                switch self {
                case .continueSignIn(let payload):
                    try container.encode("continueSignIn", forKey: .status)
                    try payload.encode(to: encoder)
                case .signedIn(let payload):
                    try container.encode("signedIn", forKey: .status)
                    try payload.encode(to: encoder)
                }
            }

            init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                switch try container.decode(String.self, forKey: .status) {
                case "continueSignIn": self = .continueSignIn(try ContinueSignIn(from: decoder))
                case "signedIn": self = .signedIn(try SignedIn(from: decoder))
                case let other:
                    throw DecodingError.dataCorruptedError(forKey: .status, in: container, debugDescription: "Unknown value: \(other)")
                }
            }
        }
    }

    // MARK: - Outer discriminator (status)

    func testDecodesSignedInArm() throws {
        let json = Data(#"{"status":"signedIn","user":{"userId":"u","username":"u","userSub":"s","groups":["admins"]}}"#.utf8)
        let result = try JSONDecoder().decode(CognitoSignIn.Result.self, from: json)
        guard case .signedIn(let payload) = result else { return XCTFail("expected .signedIn") }
        XCTAssertEqual(payload.user.userSub, "s")
        XCTAssertEqual(payload.user.groups, ["admins"])
    }

    // MARK: - Nested discriminator (name) inside the continueSignIn arm

    func testDecodesNestedNextStepArm() throws {
        let json = Data(#"{"status":"continueSignIn","nextStep":{"name":"CONFIRM_SIGN_IN_WITH_TOTP_CODE","session":"sess-1"}}"#.utf8)
        let result = try JSONDecoder().decode(CognitoSignIn.Result.self, from: json)
        guard case .continueSignIn(let outer) = result else { return XCTFail("expected .continueSignIn") }
        guard case .confirm_Sign_In_With_Totp_Code(let inner) = outer.nextStep else {
            return XCTFail("expected nested TOTP arm")
        }
        XCTAssertEqual(inner.session, "sess-1")
    }

    func testDecodesNestedArmWithEnumArray() throws {
        let jsonString = #"{"status":"continueSignIn","nextStep":"# +
            #"{"name":"CONTINUE_SIGN_IN_WITH_MFA_SELECTION","# +
            #""session":"s","allowedMFATypes":["SMS","TOTP"]}}"#
        let json = Data(jsonString.utf8)
        let result = try JSONDecoder().decode(CognitoSignIn.Result.self, from: json)
        guard case .continueSignIn(let outer) = result,
              case .continue_Sign_In_With_Mfa_Selection(let inner) = outer.nextStep else {
            return XCTFail("expected nested MFA-selection arm")
        }
        XCTAssertEqual(inner.allowedMFATypes, [.sMS, .tOTP])
    }

    // MARK: - Round-trip + unknown discriminant

    func testNestedRoundTrip() throws {
        let original = CognitoSignIn.Result.continueSignIn(
            .init(nextStep: .confirm_Sign_In_With_Totp_Code(.init(session: "sess-2"))))
        let encoded = try JSONEncoder().encode(original)
        let asString = String(data: encoded, encoding: .utf8)!
        XCTAssertTrue(asString.contains("\"status\":\"continueSignIn\""))
        XCTAssertTrue(asString.contains("\"name\":\"CONFIRM_SIGN_IN_WITH_TOTP_CODE\""))

        let decoded = try JSONDecoder().decode(CognitoSignIn.Result.self, from: encoded)
        guard case .continueSignIn(let outer) = decoded,
              case .confirm_Sign_In_With_Totp_Code(let inner) = outer.nextStep else {
            return XCTFail("round-trip lost the nested arm")
        }
        XCTAssertEqual(inner.session, "sess-2")
    }

    func testUnknownOuterStatusThrows() {
        let json = Data(#"{"status":"bogus"}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(CognitoSignIn.Result.self, from: json))
    }

    func testUnknownNestedNameThrows() {
        let json = Data(#"{"status":"continueSignIn","nextStep":{"name":"NOPE"}}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(CognitoSignIn.Result.self, from: json))
    }
}
// swiftlint:enable nesting
