//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

// MARK: - Spec diagnostics

extension SwiftCodeGenerator {
    /// One `swift:` line per spec shape the generated code can't express as written. (A nested `oidc/client`
    /// needs none: it hydrates through the client's decoder.)
    func specWarnings(for model: CodegenModel) -> [String] {
        var warnings: [String] = []
        for typeDef in model.typeDefinitions where reservedModelNames.contains(typeDef.name) {
            warnings.append(
                "swift: model '\(typeDef.name)' takes a name the generated API file declares or qualifies with,"
                + " so the output won't compile; rename the schema."
            )
        }
        return warnings
    }
}
