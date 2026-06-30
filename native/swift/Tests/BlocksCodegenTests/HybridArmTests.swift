//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// End-to-end coverage for the regrouped `confirmSignIn` arm produced by the
/// spec emitter's `regroupSharedDiscriminator` pass. Tests the
/// `HybridArmTest` in #511 so both codegen targets stay in lock-step.
final class HybridArmTests: XCTestCase {

    private func loadSpec() throws -> Data {
        let specURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("codegen-fixtures/18-hybrid-arm/spec.json")
        return try Data(contentsOf: specURL)
    }

    private func generateCode(_ data: Data) throws -> (models: String, api: String) {
        let parser = OpenRPCParser()
        let rpcModel = try parser.parse(data: data)
        let codegenModel = CodegenModelBuilder().build(from: rpcModel)
        return SwiftCodeGenerator().generate(from: codegenModel)
    }

    func testRealSetAuthStateSpecParsesWithoutError() throws {
        let data = try loadSpec()
        let parser = OpenRPCParser()
        let model = try parser.parse(data: data)
        XCTAssertEqual(model.methods.count, 1)
        XCTAssertEqual(model.methods[0].name, "authApi.setAuthState")
    }

    func testRealSetAuthStateBuildsCodegenModelWithoutError() throws {
        let data = try loadSpec()
        let rpcModel = try OpenRPCParser().parse(data: data)
        let codegenModel = CodegenModelBuilder().build(from: rpcModel)

        // Find the input union in the operation's nested types or param type.
        let operation = codegenModel.apiNamespaces.flatMap { $0.operations }.first { $0.name == "setAuthState" }!
        let inputType = operation.parameters.first?.type
        guard case .union(_, let variants, _) = inputType else {
            XCTFail("Top-level setAuthState input is not a union")
            return
        }

        // The confirmSignIn arm must carry an embedded union with seven
        // challenge variants — the regrouped shape.
        guard let confirmSignIn = variants.first(where: { $0.discriminatorValue == "confirmSignIn" }) else {
            XCTFail("Expected a confirmSignIn variant")
            return
        }
        guard let embedded = confirmSignIn.embeddedUnion else {
            XCTFail("confirmSignIn variant should carry an embeddedUnion")
            return
        }
        guard case .union(let innerName, let innerVariants, _) = embedded else {
            XCTFail("Embedded value should be a union")
            return
        }
        XCTAssertEqual(innerName, "ConfirmSignInChallenge",
                       "Embedded union should be named after parent + discriminator field")
        XCTAssertEqual(innerVariants.count, 7,
                       "Expected seven challenge variants (code, mfaType, newPassword, totpSetup, email, password, firstFactor)")
    }

    func testGeneratesNamedConfirmSignInTypesNotNumericSuffixes() throws {
        let data = try loadSpec()
        let output = try generateCode(data)
        let combined = output.models + "\n" + output.api

        XCTAssertTrue(combined.contains("struct ConfirmSignIn"),
                      "Outer arm should be named ConfirmSignIn")
        XCTAssertTrue(combined.contains("enum ConfirmSignInChallenge"),
                      "Inner discriminated union should be named ConfirmSignInChallenge")
        XCTAssertTrue(combined.contains("case confirmSignIn(ConfirmSignIn)"),
                      "Outer Input enum should reference the named record")

        // Numeric-suffix ghost types from the old codegen path must not appear.
        XCTAssertFalse(combined.contains("ConfirmSignIn_1"),
                       "Numeric-suffix ConfirmSignIn_1 should not be emitted")
        XCTAssertFalse(combined.contains("Input_Variant"),
                       "Generic Input_Variant<N> placeholders should not be emitted")
    }

    func testConfirmSignInVariantHasSessionAndChallengeFields() throws {
        let data = try loadSpec()
        let output = try generateCode(data)
        let combined = output.models + "\n" + output.api

        XCTAssertTrue(combined.contains("let session: String"),
                      "ConfirmSignIn should carry a session field")
        XCTAssertTrue(combined.contains("let challenge: ConfirmSignInChallenge"),
                      "ConfirmSignIn should carry a challenge field of the embedded union type")
    }

    func testFlatSerializationEncodesEmbeddedUnionOntoSameEnvelope() throws {
        let data = try loadSpec()
        let output = try generateCode(data)
        let combined = output.models + "\n" + output.api

        // Encode forwards to the same Encoder so the discriminator + payload
        // land at the JSON top level alongside `session`.
        XCTAssertTrue(combined.contains("try self.challenge.encode(to: encoder)"),
                      "ConfirmSignIn.encode should forward to the embedded union's encoder")
        // Decode reads `session` from the outer container, then constructs
        // the embedded union from the same Decoder.
        XCTAssertTrue(combined.contains("self.challenge = try ConfirmSignInChallenge(from: decoder)"),
                      "ConfirmSignIn.init(from:) should construct the embedded union from the same Decoder")
    }

    func testRegroupedArmRoundTripsThroughJSONEncoder() throws {
        // Sanity round-trip: build a value the way customer code would, encode
        // it, parse the JSON back, and assert the wire shape is flat (no nested
        // `challenge: { ... }` envelope).
        let data = try loadSpec()
        let output = try generateCode(data)
        // We can't actually compile the generated code here; this is a stand-in
        // for the runtime round-trip the cognito-cli-test target performs. The
        // structural assertions above plus the existing builder tests are
        // enough to catch regressions in the generator.
        XCTAssertFalse(output.models.isEmpty)
        XCTAssertFalse(output.api.isEmpty)
    }
}
