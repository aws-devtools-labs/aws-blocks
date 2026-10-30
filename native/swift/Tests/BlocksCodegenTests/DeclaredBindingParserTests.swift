//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

final class DeclaredBindingParserTests: XCTestCase {
    private let parser = OpenRPCParser()

    private func binding(
        id: String = "link",
        kind: String = "transferable",
        tag: String = "example-iot/device-link",
        package: String = "example-iot-native",
        export: String = "deviceLink",
        abi: String = "blocks-transferable-v1",
        arity: Int = 1
    ) -> String {
        """
        { "id": "\(id)", "kind": "\(kind)", "tag": "\(tag)", "package": "\(package)", \
        "export": "\(export)", "abi": "\(abi)", "genericArity": \(arity) }
        """
    }

    private func packagesCatalog(version: Int = 1, module: String = "ExampleIotNative") -> String {
        let swiftEntry = """
        "swift": { "package": { "identity": "example-iot-native", \
        "product": "ExampleIotNative", "module": "\(module)" } }
        """
        return """
        { "schemaVersion": \(version), \
        "packages": { "example-iot-native": { "platforms": { \(swiftEntry) } } } }
        """
    }

    private func bindingsCatalog(version: Int = 1, _ bindings: String...) -> String {
        """
        { "schemaVersion": \(version), "bindings": [\(bindings.joined(separator: ", "))] }
        """
    }

    private func catalogSpec(packages: String? = nil, bindings: String? = nil) -> Data {
        Data("""
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [],
            "x-blocks-native-packages": \(packages ?? packagesCatalog()),
            "x-blocks-native-bindings": \(bindings ?? bindingsCatalog(binding()))
        }
        """.utf8)
    }

    private func assertInvalidCatalog(_ spec: Data, contains fragment: String) {
        XCTAssertThrowsError(try parser.parse(data: spec)) { error in
            guard case CodegenError.invalidNativeCatalog(let detail) = error else {
                return XCTFail("Expected CodegenError.invalidNativeCatalog, got \(error)")
            }
            XCTAssertTrue(detail.contains(fragment), "expected '\(fragment)' in: \(detail)")
        }
    }

    func testResolvesDeclaredTransferableBinding() throws {
        let model = try parser.parse(data: catalogSpec())
        let resolved = model.declaredTransferableBindings["example-iot/device-link"]
        XCTAssertEqual(resolved?.module, "ExampleIotNative")
        XCTAssertEqual(resolved?.base, "ExampleIotNative.DeviceLink")
        XCTAssertEqual(resolved?.factory, "fromBlocksDescriptor")
        XCTAssertEqual(resolved?.isGeneric, true)
    }

    func testBindingNamingAnUndeclaredPackageIsAnError() {
        let spec = catalogSpec(bindings: bindingsCatalog(binding(package: "absent-package")))
        assertInvalidCatalog(spec, contains: "absent-package")
    }

    func testUnknownFactoryABIIsAnError() {
        let spec = catalogSpec(bindings: bindingsCatalog(binding(abi: "blocks-transferable-v9")))
        assertInvalidCatalog(spec, contains: "blocks-transferable-v9")
    }

    func testGenericArityAboveOneIsAnError() {
        assertInvalidCatalog(catalogSpec(bindings: bindingsCatalog(binding(arity: 2))), contains: "genericArity 2")
    }

    func testDuplicateTagIsAnError() {
        let spec = catalogSpec(bindings: bindingsCatalog(
            binding(id: "a"),
            binding(id: "b", export: "otherLink")
        ))
        assertInvalidCatalog(spec, contains: "bound by more than one binding")
    }

    func testDuplicateTagIsAnErrorEvenWhenTheFirstBindingIsDropped() {
        let spec = catalogSpec(bindings: bindingsCatalog(
            binding(id: "a", tag: "file-bucket/download", arity: 0),
            binding(id: "b", tag: "file-bucket/download", export: "otherLink", arity: 0)
        ))
        assertInvalidCatalog(spec, contains: "bound by more than one binding")
    }

    func testUnknownPackagesSchemaVersionIsAnError() {
        assertInvalidCatalog(
            catalogSpec(packages: packagesCatalog(version: 2)),
            contains: "x-blocks-native-packages declares schemaVersion 2"
        )
    }

    func testUnknownBindingsSchemaVersionIsAnError() {
        assertInvalidCatalog(
            catalogSpec(bindings: bindingsCatalog(version: 2, binding())),
            contains: "x-blocks-native-bindings declares schemaVersion 2"
        )
    }

    func testAnUndefinedKindWithAnOutOfRangeGenericArityIsStillAnError() {
        assertInvalidCatalog(
            catalogSpec(bindings: bindingsCatalog(binding(kind: "facade", arity: 7))),
            contains: "declares genericArity 7"
        )
    }

    func testAnUndefinedKindWithAnAbsentGenericArityIsStillAnError() {
        assertInvalidCatalog(
            catalogSpec(bindings: bindingsCatalog(
                binding(kind: "facade").replacingOccurrences(of: #", "genericArity": 1"#, with: "")
            )),
            contains: "requires a genericArity"
        )
    }

    func testAnUndefinedKindWhoseExportIsNotATypeIsStillAnError() {
        assertInvalidCatalog(
            catalogSpec(bindings: bindingsCatalog(binding(kind: "facade", export: "9not"))),
            contains: "does not name a Swift type"
        )
    }

    func testModuleThatIsNotASwiftIdentifierIsAnError() {
        for module in ["A.B", "example-iot", "9Native", "has space"] {
            assertInvalidCatalog(
                catalogSpec(packages: packagesCatalog(module: module)),
                contains: "declares Swift module '\(module)', which is not usable as `import <module>`"
            )
        }
    }

    func testModuleThatIsASwiftKeywordIsAnError() {
        // isValidSwiftIdentifier accepts it; the swiftKeywords guard is what rejects it.
        assertInvalidCatalog(catalogSpec(packages: packagesCatalog(module: "import")), contains: "is not usable as `import <module>`")
    }

    func testExportThatDoesNotPascalCaseToATypeNameIsAnError() {
        for export in ["-", "3dHandle", "...", "1"] {
            assertInvalidCatalog(
                catalogSpec(bindings: bindingsCatalog(binding(export: export))),
                contains: "declares export '\(export)', which does not name a Swift type"
            )
        }
    }

    func testExportThatPascalCasesToASwiftKeywordIsAnError() {
        assertInvalidCatalog(catalogSpec(bindings: bindingsCatalog(binding(export: "Self"))), contains: "does not name a Swift type")
    }

    func testAnUndefinedKindNamingAnUndeclaredPackageIsStillAnError() {
        assertInvalidCatalog(
            catalogSpec(bindings: bindingsCatalog(binding(id: "other", kind: "facade", package: "not-declared"))),
            contains: "names package 'not-declared'"
        )
    }

    func testTagUniquenessSpansEveryKind() {
        let bindings = bindingsCatalog(
            binding(id: "first"),
            binding(id: "second", kind: "facade")
        )
        assertInvalidCatalog(catalogSpec(bindings: bindings), contains: "is bound by more than one binding")
    }

    func testANewlineInASpecValueCannotSplitACatalogError() {
        let forged = #"ev\nAWSBLOCKS-NATIVE-999: forged"#
        assertInvalidCatalog(
            catalogSpec(bindings: bindingsCatalog(binding(package: forged))),
            contains: #"names package 'ev\nAWSBLOCKS-NATIVE-999: forged'"#
        )
    }

    func testAbsentGenericArityIsAnError() {
        let bindings = """
        { "schemaVersion": 1, "bindings": [{ "id": "link", "kind": "transferable", \
        "tag": "example-iot/device-link", "package": "example-iot-native", \
        "export": "deviceLink", "abi": "blocks-transferable-v1" }] }
        """
        assertInvalidCatalog(
            catalogSpec(bindings: bindings),
            contains: "binding 'link' requires a genericArity in 0...1"
        )
    }

    func testPackageEntryWithoutPlatformsMatchesEmptyPlatforms() throws {
        let absent = """
        { "schemaVersion": 1, "packages": { "example-iot-native": {} } }
        """
        let empty = """
        { "schemaVersion": 1, "packages": { "example-iot-native": { "platforms": {} } } }
        """
        for packages in [absent, empty] {
            XCTAssertTrue(
                try parser.parse(data: catalogSpec(packages: packages)).declaredTransferableBindings.isEmpty,
                "a package with no platform entry must not resolve a Swift binding"
            )
        }
    }

    func testExportSeparatorsAreDroppedForUpperCamelCase() throws {
        for export in ["device_link", "device-link", "device.link", "DEVICE_LINK"] {
            let model = try parser.parse(data: catalogSpec(bindings: bindingsCatalog(binding(export: export))))
            XCTAssertEqual(
                model.declaredTransferableBindings["example-iot/device-link"]?.base,
                "ExampleIotNative.DeviceLink",
                "export '\(export)' must resolve to upper camel case"
            )
        }
    }

    func testExportResolvingToANameIllegalWhenQualifiedIsAnError() {
        for export in ["type", "protocol", "any"] {
            assertInvalidCatalog(
                catalogSpec(bindings: bindingsCatalog(binding(export: export))),
                contains: "does not name a Swift type"
            )
        }
    }

    func testTwoPackagesDeclaringOneSwiftModuleIsAnError() {
        let packages = """
        { "schemaVersion": 1, "packages": { \
        "example-iot-native": { "platforms": { "swift": { "package": \
        { "identity": "example-iot-native", "product": "Shared", "module": "SharedMod" } } } }, \
        "other-native": { "platforms": { "swift": { "package": \
        { "identity": "other-native", "product": "Shared", "module": "SharedMod" } } } } } }
        """
        let bindings = bindingsCatalog(
            binding(id: "a", tag: "example-iot/a", export: "alpha", arity: 0),
            binding(id: "b", tag: "example-iot/b", package: "other-native", export: "beta", arity: 0)
        )
        assertInvalidCatalog(
            catalogSpec(packages: packages, bindings: bindings),
            contains: "declare Swift module 'SharedMod' with different package metadata"
        )
    }

    func testBindingOnABuiltInTagIsReported() throws {
        let bindings = bindingsCatalog(binding(id: "shadow", tag: "file-bucket/download", export: "alpha", arity: 0))
        let model = try parser.parse(data: catalogSpec(bindings: bindings))
        XCTAssertTrue(model.declaredTransferableBindings.isEmpty)
        XCTAssertTrue(
            model.nativeCatalogWarnings.contains { $0.contains("AWSBLOCKS-NATIVE-005") && $0.contains("file-bucket/download") },
            "a binding on a built-in tag can never apply, so it must be named: \(model.nativeCatalogWarnings)"
        )
    }

    func testAnEmptyContainerAndAnAbsentContainerAreTheSameDeclaration() throws {
        let packageShapes = [
            "",
            #", "x-blocks-native-packages": { "schemaVersion": 1, "packages": {} }"#,
            #", "x-blocks-native-packages": { "schemaVersion": 1 }"#
        ]
        let bindingShapes = [
            "",
            #", "x-blocks-native-bindings": { "schemaVersion": 1, "bindings": [] }"#,
            #", "x-blocks-native-bindings": { "schemaVersion": 1 }"#
        ]
        for packages in packageShapes {
            for bindings in bindingShapes {
                let spec = Data("""
                {
                    "openrpc": "1.3.2",
                    "info": { "title": "test", "version": "1.0.0" },
                    "methods": []\(packages)\(bindings)
                }
                """.utf8)
                let model = try parser.parse(data: spec)
                XCTAssertTrue(
                    model.declaredTransferableBindings.isEmpty,
                    "no container declares anything, so nothing can resolve"
                )
                XCTAssertEqual(model.nativeCatalogWarnings, [], "nothing is declared, so nothing is unreferenced")
            }
        }
    }

    func testOptOutAgainstASpecDeclaringNoPackagesWarnsRatherThanFails() throws {
        // Only a codegen fixture carries the catalogs on main, so neither may break a build.
        let absent = """
            "methods": []
        """
        let empty = """
            "methods": [],
            "x-blocks-native-packages": { "schemaVersion": 1, "packages": {} }
        """
        let keyMissing = """
            "methods": [],
            "x-blocks-native-packages": { "schemaVersion": 1 }
        """
        for body in [absent, empty, keyMissing] {
            let spec = Data("""
            {
                "openrpc": "1.3.2",
                "info": { "title": "test", "version": "1.0.0" },
            \(body)
            }
            """.utf8)
            let optOut = OpenRPCParser(optOutNativePackages: ["example-iot-native"])
            let model = try optOut.parse(data: spec)
            XCTAssertTrue(model.declaredTransferableBindings.isEmpty)
            XCTAssertTrue(
                model.nativeCatalogWarnings.contains {
                    $0.contains("AWSBLOCKS-NATIVE-006") && $0.contains("example-iot-native")
                },
                "got: \(model.nativeCatalogWarnings)"
            )
        }
    }

    func testModuleThatCannotBeImportedIsAnError() {
        // `import Any` does not parse; `Type` and `Protocol` are legal in base position
        // but the set is shared with the export check, so all three are refused.
        for module in ["Any", "Type", "Protocol"] {
            assertInvalidCatalog(
                catalogSpec(packages: packagesCatalog(module: module)),
                contains: "is not usable as `import <module>`"
            )
        }
    }

    func testEmptyTagIsAnError() {
        assertInvalidCatalog(catalogSpec(bindings: bindingsCatalog(binding(tag: ""))), contains: "declares an empty tag")
    }

    func testAnEmptyTagIsAnErrorWhateverTheKind() {
        assertInvalidCatalog(
            catalogSpec(bindings: bindingsCatalog(binding(kind: "opaque", tag: ""))),
            contains: "declares an empty tag"
        )
    }

    func testPackageReferencedOnlyByANonTransferableBindingIsStillReferenced() throws {
        let bindings = bindingsCatalog(binding(id: "other", kind: "opaque"))
        let model = try parser.parse(data: catalogSpec(bindings: bindings))
        XCTAssertFalse(
            model.nativeCatalogWarnings.contains {
                $0.contains("AWSBLOCKS-NATIVE-003") && $0.contains("example-iot-native")
            },
            "a package a binding names is referenced whatever the kind, got: \(model.nativeCatalogWarnings)"
        )
        XCTAssertTrue(
            model.nativeCatalogWarnings.contains { $0.contains("AWSBLOCKS-NATIVE-004") && $0.contains("opaque") },
            "got: \(model.nativeCatalogWarnings)"
        )
    }

    func testOptOutEntryMatchingNoDeclaredPackageWarnsRatherThanFails() throws {
        let optOut = OpenRPCParser(optOutNativePackages: ["exampl-iot-native"])
        let model = try optOut.parse(data: catalogSpec())
        XCTAssertTrue(
            model.nativeCatalogWarnings.contains {
                $0.contains("AWSBLOCKS-NATIVE-006") && $0.contains("exampl-iot-native")
                    && $0.contains("not declared in x-blocks-native-packages")
            },
            "a typo'd opt-out must warn, got:\n\(model.nativeCatalogWarnings.joined(separator: "\n"))"
        )
        XCTAssertFalse(
            model.declaredTransferableBindings.isEmpty,
            "the real binding must still resolve"
        )
    }

    func testMalformedMetadataIsRejectedEvenWhenTheBindingWouldBeDropped() {
        let bindings = bindingsCatalog(binding(id: "shadow", tag: "file-bucket/download", export: "9bad", arity: 0))
        assertInvalidCatalog(catalogSpec(bindings: bindings), contains: "does not name a Swift type")
    }

    func testMalformedModuleIsRejectedEvenWhenThePackageIsOptedOut() {
        let spec = catalogSpec(packages: packagesCatalog(module: "A.B"))
        let optOut = OpenRPCParser(optOutNativePackages: ["example-iot-native"])
        XCTAssertThrowsError(try optOut.parse(data: spec)) { error in
            guard case CodegenError.invalidNativeCatalog(let detail) = error else {
                return XCTFail("Expected CodegenError.invalidNativeCatalog, got \(error)")
            }
            XCTAssertTrue(detail.contains("is not usable as `import <module>`"), "got: \(detail)")
        }
    }

    func testTwoBindingsResolvingToTheSameSwiftTypeIsAnError() {
        let bindings = bindingsCatalog(
            binding(id: "a", tag: "example-iot/a", export: "deviceHandle", arity: 0),
            binding(id: "b", tag: "example-iot/b", export: "device-handle", arity: 0)
        )
        assertInvalidCatalog(catalogSpec(bindings: bindings), contains: "already resolved by export 'deviceHandle'")
    }

    func testOneExportDeclaredAtTwoGenericAritiesIsAnError() {
        // `DeviceHandle` and `DeviceHandle<T>` cannot both be the emitted type.
        let bindings = bindingsCatalog(
            binding(id: "a", tag: "example-iot/a", export: "deviceHandle", arity: 0),
            binding(id: "b", tag: "example-iot/b", export: "deviceHandle", arity: 1)
        )
        assertInvalidCatalog(catalogSpec(bindings: bindings), contains: "at generic arity 0")
    }

    func testOneSwiftModuleFromTwoDifferentProductsIsAnError() {
        let packages = """
        { "schemaVersion": 1, "packages": { \
        "example-iot-native": { "platforms": { "swift": { "package": \
        { "identity": "example-iot-native", "product": "ProductA", "module": "SharedMod" } } } }, \
        "other-native": { "platforms": { "swift": { "package": \
        { "identity": "example-iot-native", "product": "ProductB", "module": "SharedMod" } } } } } }
        """
        let bindings = bindingsCatalog(
            binding(id: "a", tag: "example-iot/a", export: "handleOne", arity: 0),
            binding(id: "b", tag: "example-iot/b", package: "other-native", export: "handleTwo", arity: 0)
        )
        assertInvalidCatalog(
            catalogSpec(packages: packages, bindings: bindings),
            contains: "with different package metadata"
        )
    }

    func testTwoCatalogKeysNamingOneSwiftPackageIsAccepted() throws {
        let packages = """
        { "schemaVersion": 1, "packages": { \
        "example-iot-native": { "platforms": { "swift": { "package": \
        { "identity": "example-iot-native", "product": "ExampleIotNative", "module": "ExampleIotNative" } } } }, \
        "example-iot-alias": { "platforms": { "swift": { "package": \
        { "identity": "example-iot-native", "product": "ExampleIotNative", "module": "ExampleIotNative" } } } } } }
        """
        let bindings = bindingsCatalog(
            binding(id: "a", tag: "example-iot/a", export: "handleOne", arity: 0),
            binding(id: "b", tag: "example-iot/b", package: "example-iot-alias", export: "handleTwo", arity: 0)
        )
        let model = try parser.parse(data: catalogSpec(packages: packages, bindings: bindings))
        XCTAssertEqual(model.declaredTransferableBindings.count, 2, "one package under two keys must resolve both")
    }

    func testNonTransferableBindingKindIsIgnored() throws {
        let spec = catalogSpec(bindings: bindingsCatalog(binding(id: "later", kind: "facade")))
        let model = try parser.parse(data: spec)
        XCTAssertTrue(model.declaredTransferableBindings.isEmpty, "schema 1 defines only the transferable kind")
    }

    func testBindingsWithoutAPackageCatalogIsAnError() {
        let spec = Data("""
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [],
            "x-blocks-native-bindings": \(bindingsCatalog(binding()))
        }
        """.utf8)
        assertInvalidCatalog(spec, contains: "which x-blocks-native-packages does not declare")
    }

    func testSwiftEntryMissingARequiredFieldIsADecodingError() throws {
        for omitted in ["identity", "product"] {
            let fields = ["identity": "ex-native", "product": "ExNative", "module": "ExNative"]
                .filter { $0.key != omitted }
                .map { "\"\($0.key)\": \"\($0.value)\"" }
                .sorted()
                .joined(separator: ", ")
            let packages = """
            { "schemaVersion": 1, "packages": { "example-iot-native": { "platforms": \
            { "swift": { "package": { \(fields) } } } } } }
            """
            XCTAssertThrowsError(try parser.parse(data: catalogSpec(packages: packages)), omitted) { error in
                guard case DecodingError.keyNotFound(let key, _) = error else {
                    return XCTFail("omitting \(omitted) should be a DecodingError, got \(error)")
                }
                XCTAssertEqual(key.stringValue, omitted, "the error must name the omitted field")
            }
        }
    }
}
