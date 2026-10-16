//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

final class DeclaredTransferableBindingTests: XCTestCase {
    private func generate(from json: String, optOut: Set<String> = []) throws -> GeneratedSources {
        let rpcModel = try OpenRPCParser(optOutNativePackages: optOut).parse(data: Data(json.utf8))
        return try SwiftCodeGenerator().generate(from: CodegenModelBuilder().build(from: rpcModel))
    }

    private func binding(
        id: String,
        tag: String,
        export: String,
        arity: Int,
        abi: String = "blocks-transferable-v1",
        package: String = "example-iot-native"
    ) -> String {
        """
        { "id": "\(id)", "kind": "transferable", "tag": "\(tag)", "package": "\(package)", \
        "export": "\(export)", "abi": "\(abi)", "genericArity": \(arity) }
        """
    }

    private func swiftPackagesCatalog() -> String {
        """
        { "schemaVersion": 1, "packages": { "example-iot-native": { "platforms": { "swift": \
        { "package": { "identity": "example-iot-native", "product": "ExampleIotNative", \
        "module": "ExampleIotNative" } } } } } }
        """
    }

    private func androidOnlyPackagesCatalog() -> String {
        """
        { "schemaVersion": 1, "packages": { "example-iot-native": { "platforms": { "android": \
        { "package": { "group": "com.example.blocks", "artifact": "iot-native", \
        "kotlinPackage": "com.example.blocks.iot" } } } } } }
        """
    }

    private func catalogSpec(methods: String, packages: String? = nil, bindings: [String]) -> String {
        """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [\(methods)],
            "x-blocks-native-packages": \(packages ?? swiftPackagesCatalog()),
            "x-blocks-native-bindings": { "schemaVersion": 1, "bindings": [\(bindings.joined(separator: ", "))] }
        }
        """
    }

    private func transferableMethod(_ name: String, tag: String, withTypeArg: Bool = false) -> String {
        let typeArgs = withTypeArg ? """
        , "x-blocks-type-args": [{ "type": "object", \
        "properties": { "temperature": { "type": "number" } }, "required": ["temperature"] }]
        """ : ""
        return """
        {
            "name": "api.\(name)",
            "params": [],
            "result": { "name": "R", "schema": { "x-blocks-transferable": "\(tag)"\(typeArgs) } }
        }
        """
    }

    private func declaredBindingSpec(packages: String? = nil, linkTag: String = "example-iot/device-link") -> String {
        catalogSpec(
            methods: [
                transferableMethod("getDeviceHandle", tag: "example-iot/device-handle"),
                transferableMethod("connectDevice", tag: "example-iot/device-link", withTypeArg: true)
            ].joined(separator: ", "),
            packages: packages,
            bindings: [
                binding(id: "handle", tag: "example-iot/device-handle", export: "deviceHandle", arity: 0),
                binding(id: "link", tag: linkTag, export: "deviceLink", arity: 1)
            ]
        )
    }

    private var handleFactoryCall: String {
        #"""
            return try ExampleIotNative.DeviceHandle.fromBlocksDescriptor(
                BlocksRuntime.validateTransferableDescriptor(descriptor, expectedTag: "example-iot/device-handle")
            )
    """#
    }

    func testDeclaredArityZeroBindingPassesNoDecoder() throws {
        let spec = catalogSpec(
            methods: transferableMethod("getDeviceHandle", tag: "example-iot/device-handle"),
            bindings: [binding(id: "handle", tag: "example-iot/device-handle", export: "deviceHandle", arity: 0)]
        )
        let output = try generate(from: spec)
        XCTAssertTrue(output.api.contains(handleFactoryCall), "the arity-zero factory call was not emitted, got:\n\(output.api)")
        XCTAssertFalse(output.api.contains("{ data in"), "an arity-zero factory takes no decoder, got:\n\(output.api)")
        XCTAssertFalse(output.api.contains("JSONDecoder().decode"), "got:\n\(output.api)")
    }

    func testDeclaredArityZeroBindingEmitsDeclaredTypeAndABIFactory() throws {
        let output = try generate(from: declaredBindingSpec())
        XCTAssertTrue(output.api.contains("-> ExampleIotNative.DeviceHandle {"), "export deviceHandle should resolve to DeviceHandle, got:\n\(output.api)")
        XCTAssertTrue(
            output.api.contains(handleFactoryCall),
            "arity-zero factory call does not match the blocks-transferable-v1 shape, got:\n\(output.api)"
        )
        XCTAssertFalse(output.api.contains("UnknownTransferable"), "a declared binding must not use the fallback, got:\n\(output.api)")
    }

    func testDeclaredArityOneBindingSpecializesAndPassesTheGeneratedDecoder() throws {
        let output = try generate(from: declaredBindingSpec())
        let linkFactoryCall = #"""
                return try ExampleIotNative.DeviceLink<ConnectDevice.ResultMessage>.fromBlocksDescriptor(
                    BlocksRuntime.validateTransferableDescriptor(descriptor, expectedTag: "example-iot/device-link")
                ) { data in
        """#
        XCTAssertTrue(
            output.api.contains("-> ExampleIotNative.DeviceLink<ConnectDevice.ResultMessage> {"),
            "arity-one result should specialize on the generated payload model, got:\n\(output.api)"
        )
        XCTAssertTrue(
            output.api.contains(linkFactoryCall),
            "arity-one factory call does not match the blocks-transferable-v1 shape, got:\n\(output.api)"
        )
        XCTAssertTrue(
            output.api.contains("try JSONDecoder().decode(ConnectDevice.ResultMessage.self, from: data)"),
            "the package factory must receive the generated model's decoder, got:\n\(output.api)"
        )
    }

    func testDeclaredBindingImportsTheDeclaredModuleOnce() throws {
        let output = try generate(from: declaredBindingSpec())
        XCTAssertEqual(
            output.api.components(separatedBy: "import ExampleIotNative").count - 1, 1,
            "two bindings on one package should emit one import, got:\n\(output.api)"
        )
    }

    func testPackageWithoutSwiftPlatformEntryFallsBack() throws {
        let output = try generate(from: declaredBindingSpec(packages: androidOnlyPackagesCatalog()))
        XCTAssertTrue(output.api.contains("-> BlocksRuntime.UnknownTransferable"), "a missing swift entry must fall back, got:\n\(output.api)")
        XCTAssertFalse(output.api.contains("import ExampleIotNative"), "a fallen-back package must not be imported, got:\n\(output.api)")
        XCTAssertEqual(output.warnings.count, 2, "both unbound operations should report AWSBLOCKS-NATIVE-001")
        XCTAssertTrue(
            output.warnings.allSatisfy { $0.contains("(package 'example-iot-native' declares no swift platform)") },
            "the diagnostic must name the cause, got:\n\(output.warnings.joined(separator: "\n"))"
        )
    }

    func testOptedOutPackageFallsBackAndIsNotImported() throws {
        let output = try generate(from: declaredBindingSpec(), optOut: ["example-iot-native"])
        XCTAssertTrue(output.api.contains("-> BlocksRuntime.UnknownTransferable"), "an opted-out package must fall back, got:\n\(output.api)")
        XCTAssertFalse(output.api.contains("import ExampleIotNative"), "an opted-out package must not be imported, got:\n\(output.api)")
        XCTAssertFalse(output.api.contains("fromBlocksDescriptor"), "an opted-out package must emit no factory call, got:\n\(output.api)")
    }

    func testOptOutOfAnotherDeclaredPackageKeepsThisTypedBinding() throws {
        let packages = """
        { "schemaVersion": 1, "packages": { \
        "example-iot-native": { "platforms": { "swift": { "package": \
        { "identity": "example-iot-native", "product": "ExampleIotNative", "module": "ExampleIotNative" } } } }, \
        "other-native": { "platforms": { "swift": { "package": \
        { "identity": "other-native", "product": "OtherNative", "module": "OtherNative" } } } } } }
        """
        let output = try generate(from: declaredBindingSpec(packages: packages), optOut: ["other-native"])
        XCTAssertTrue(
            output.api.contains("-> ExampleIotNative.DeviceHandle {"),
            "opting out of another identity must not disturb this one, got:\n\(output.api)"
        )
    }

    func testOptedOutFallbackNamesTheOptedOutPackage() throws {
        let output = try generate(from: declaredBindingSpec(), optOut: ["example-iot-native"])
        XCTAssertEqual(output.warnings.count, 2, "both unbound operations should report a diagnostic, got: \(output.warnings)")
        XCTAssertTrue(
            output.warnings.allSatisfy { $0.contains("(package 'example-iot-native' is opted out)") },
            "the fallback must say it was opted out, not that no binding exists, got: \(output.warnings)"
        )
    }

    func testUnrecognisedBindingKindIsReported() throws {
        let spec = catalogSpec(
            methods: transferableMethod("getDeviceHandle", tag: "example-iot/device-handle"),
            bindings: [binding(id: "typo", tag: "example-iot/device-handle", export: "deviceHandle", arity: 0)
                .replacingOccurrences(of: #""kind": "transferable""#, with: #""kind": "transferrable""#)]
        )
        let output = try generate(from: spec)
        XCTAssertTrue(
            output.warnings.contains { $0.contains("AWSBLOCKS-NATIVE-004") && $0.contains("transferrable") },
            "an unrecognised kind must be named, got: \(output.warnings)"
        )
        XCTAssertTrue(output.api.contains("-> BlocksRuntime.UnknownTransferable"), "got:\n\(output.api)")
    }

    func testDeclaredBindingCannotReplaceABuiltInTag() throws {
        let spec = catalogSpec(
            methods: transferableMethod("getFile", tag: "file-bucket/download"),
            bindings: [binding(id: "shadow", tag: "file-bucket/download", export: "deviceHandle", arity: 0)]
        )
        let output = try generate(from: spec)
        XCTAssertTrue(output.api.contains("-> FileDownloadHandle"), "a built-in tag keeps its hard-coded type, got:\n\(output.api)")
        XCTAssertTrue(
            output.api.contains("FileDownloadHandle.fromJSON(descriptor)"),
            "a built-in tag keeps its hard-coded factory, got:\n\(output.api)"
        )
        XCTAssertFalse(
            output.api.contains("import ExampleIotNative"),
            "a shadowed built-in must not import the declared module, got:\n\(output.api)"
        )
    }

    func testTagLookupIsByteExactAndCaseSensitive() throws {
        let output = try generate(from: declaredBindingSpec(linkTag: "example-iot/Device-Link"))
        XCTAssertTrue(
            output.api.contains(#"UnknownTransferable.fromJSON(descriptor, expectedTag: "example-iot/device-link")"#),
            "a case-different tag must not match, got:\n\(output.api)"
        )
        XCTAssertFalse(output.api.contains("DeviceLink<"), "a case-different tag must not resolve a typed binding, got:\n\(output.api)")
    }

    func testNullableDeclaredTransferableKeepsItsOptionalConcreteType() throws {
        let method = """
        {
            "name": "api.maybeHandle",
            "params": [],
            "result": { "name": "R", "schema": { "oneOf": [
                { "x-blocks-transferable": "example-iot/device-handle" },
                { "type": "null" }
            ]}}
        }
        """
        let spec = catalogSpec(
            methods: method,
            bindings: [binding(id: "handle", tag: "example-iot/device-handle", export: "deviceHandle", arity: 0)]
        )
        let output = try generate(from: spec)
        XCTAssertTrue(
            output.api.contains("-> ExampleIotNative.DeviceHandle?"),
            "a nullable declared transferable keeps its optional concrete type, got:\n\(output.api)"
        )
        XCTAssertTrue(
            output.api.contains("guard let result else { return nil }"),
            "a nullable result returns nil for a null body, got:\n\(output.api)"
        )
        XCTAssertTrue(
            output.api.contains(handleFactoryCall),
            "a nullable declared transferable must hydrate via the package factory, got:\n\(output.api)"
        )
        XCTAssertFalse(
            output.api.contains("JSONDecoder().decode(ExampleIotNative.DeviceHandle.self"),
            "a declared transferable must never be decoded straight from the descriptor, got:\n\(output.api)"
        )
        XCTAssertTrue(
            output.api.contains("import ExampleIotNative"),
            "a nullable-only declared binding must still import its module, got:\n\(output.api)"
        )
    }

    func testDeclaredBindingNoMethodReturnsIsNotImported() throws {
        let method = """
        { "name": "api.count", "params": [], "result": { "name": "R", "schema": { "type": "integer" } } }
        """
        let spec = catalogSpec(
            methods: method,
            bindings: [binding(id: "handle", tag: "example-iot/device-handle", export: "deviceHandle", arity: 0)]
        )
        let output = try generate(from: spec)
        XCTAssertTrue(output.api.contains("-> Int"), "the method must still generate, got:\n\(output.api)")
        XCTAssertFalse(
            output.api.contains("import ExampleIotNative"),
            "a binding no result uses must not be imported, got:\n\(output.api)"
        )
    }

    func testEveryAcceptedABIEmitsItsFactory() throws {
        XCTAssertFalse(transferableFactoriesByABI.isEmpty, "an empty ABI table would make this test vacuous")
        for (abi, factory) in transferableFactoriesByABI {
            let spec = catalogSpec(
                methods: transferableMethod("get", tag: "example-iot/device-handle"),
                bindings: [binding(id: "handle", tag: "example-iot/device-handle", export: "deviceHandle", arity: 0, abi: abi)]
            )
            let output = try generate(from: spec)
            XCTAssertTrue(
                output.api.contains("ExampleIotNative.DeviceHandle.\(factory)("),
                "\(abi) is accepted but its hydration body does not call \(factory), got:\n\(output.api)"
            )
            XCTAssertFalse(output.api.contains("UnknownTransferable"), "\(abi) is accepted but fell through to the fallback")
        }
    }

    func testDeclaredModuleImportsAreSortedDeterministically() throws {
        let names = ["Zeta", "Yankee", "Bravo", "Alpha"]
        let packages = """
        { "schemaVersion": 1, "packages": { \(names.map { name in
            """
            "\(name.lowercased())-native": { "platforms": { "swift": { "package": \
            { "identity": "\(name.lowercased())-native", "product": "\(name)Native", "module": "\(name)Native" } } } }
            """
        }.joined(separator: ", ")) } }
        """
        let spec = catalogSpec(
            methods: names.map { transferableMethod("get\($0)", tag: "example-iot/\($0.lowercased())") }.joined(separator: ", "),
            packages: packages,
            bindings: names.map { name in
                binding(
                    id: name.lowercased(), tag: "example-iot/\(name.lowercased())",
                    export: "\(name.lowercased())Handle", arity: 0, package: "\(name.lowercased())-native"
                )
            }
        )
        let emitted = try generate(from: spec).api
            .split(separator: "\n")
            .filter { $0.hasPrefix("import ") }
            .map(String.init)
        XCTAssertEqual(
            emitted,
            ["import Foundation", "import BlocksRuntime", "import AlphaNative", "import BravoNative", "import YankeeNative", "import ZetaNative"],
            "declared imports must be emitted in sorted order"
        )
    }

    func testDeclaredBindingDoesNotResolveInANestedPosition() throws {
        let method = """
        {
            "name": "api.listLinks",
            "params": [],
            "result": { "name": "R", "schema": { "type": "array", \
        "items": { "x-blocks-transferable": "example-iot/device-handle" } } }
        }
        """
        let spec = catalogSpec(
            methods: method,
            bindings: [binding(id: "handle", tag: "example-iot/device-handle", export: "deviceHandle", arity: 0)]
        )
        let output = try generate(from: spec)
        XCTAssertTrue(output.api.contains("-> [JSONValue]"), "a nested transferable stays JSONValue, got:\n\(output.api)")
        XCTAssertFalse(output.api.contains("DeviceHandle"), "a nested position must not name the package type, got:\n\(output.api)")
        XCTAssertFalse(output.api.contains("import ExampleIotNative"), "got:\n\(output.api)")
    }

    func testUnreferencedDeclaredPackageIsReportedAsAWarning() throws {
        let packages = """
        { "schemaVersion": 1, "packages": { \
        "example-iot-native": { "platforms": { "swift": { "package": \
        { "identity": "example-iot-native", "product": "ExampleIotNative", "module": "ExampleIotNative" } } } }, \
        "orphan-native": { "platforms": { "swift": { "package": \
        { "identity": "orphan-native", "product": "OrphanNative", "module": "OrphanNative" } } } } } }
        """
        let output = try generate(from: declaredBindingSpec(packages: packages))
        XCTAssertEqual(output.warnings.count, 1, "got: \(output.warnings)")
        XCTAssertTrue(output.warnings[0].contains("AWSBLOCKS-NATIVE-003"), "got: \(output.warnings)")
        XCTAssertFalse(output.api.contains("import OrphanNative"), "got:\n\(output.api)")
    }

    func testTwoPackagesExportingTheSameNameStayDistinct() throws {
        let packages = """
        { "schemaVersion": 1, "packages": { \
        "alpha-native": { "platforms": { "swift": { "package": \
        { "identity": "alpha-native", "product": "AlphaNative", "module": "AlphaNative" } } } }, \
        "zeta-native": { "platforms": { "swift": { "package": \
        { "identity": "zeta-native", "product": "ZetaNative", "module": "ZetaNative" } } } } } }
        """
        let spec = catalogSpec(
            methods: [
                transferableMethod("getA", tag: "example-iot/a"),
                transferableMethod("getB", tag: "example-iot/b")
            ].joined(separator: ", "),
            packages: packages,
            bindings: [
                binding(id: "a", tag: "example-iot/a", export: "sharedHandle", arity: 0, package: "alpha-native"),
                binding(id: "b", tag: "example-iot/b", export: "sharedHandle", arity: 0, package: "zeta-native")
            ]
        )
        let output = try generate(from: spec)
        XCTAssertTrue(output.api.contains("-> AlphaNative.SharedHandle {"), "got:\n\(output.api)")
        XCTAssertTrue(output.api.contains("-> ZetaNative.SharedHandle {"), "got:\n\(output.api)")
        XCTAssertFalse(output.api.contains("-> SharedHandle {"), "an unqualified name would be ambiguous, got:\n\(output.api)")
    }

    func testDeclaredTypeIsQualifiedEvenWhenAGeneratedModelSharesItsName() throws {
        // A local `DeviceHandle` would shadow the imported one, which has no factory.
        let method = """
        {
            "name": "api.getDeviceHandle",
            "params": [],
            "result": { "name": "R", "schema": { "x-blocks-transferable": "example-iot/device-handle" } }
        }
        """
        let spec = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [\(method)],
            "components": { "schemas": { "DeviceHandle": { "type": "object", \
        "properties": { "id": { "type": "string" } }, "required": ["id"] } } },
            "x-blocks-native-packages": \(swiftPackagesCatalog()),
            "x-blocks-native-bindings": { "schemaVersion": 1, "bindings": [\
        \(binding(id: "h", tag: "example-iot/device-handle", export: "deviceHandle", arity: 0))] }
        }
        """
        let output = try generate(from: spec)
        XCTAssertTrue(output.api.contains("-> ExampleIotNative.DeviceHandle {"), "got:\n\(output.api)")
        XCTAssertTrue(output.models.contains("public struct DeviceHandle"), "the generated model should still be emitted")
    }

    private struct ShadowCase {
        let label: String
        let module: String
        let methods: String
        let components: String

        init(_ label: String, module: String, methods: String, components: String = "") {
            self.label = label
            self.module = module
            self.methods = methods
            self.components = components
        }
    }

    private var inlineObjectSchema: String {
        #"{ "type": "object", "properties": { "a": { "type": "string" } }, "required": ["a"] }"#
    }

    private var inlineResultMethod: String {
        """
        { "name": "api.inlineResult", "params": [], "result": { "name": "R", "schema": \
        { "type": "object", "properties": { "h": { "x-blocks-transferable": "example-iot/link" } }, \
        "required": ["h"] } } }, \
        \(boundMethod)
        """
    }

    private var boundMethod: String {
        """
        { "name": "api.get", "params": [], "result": { "name": "R", "schema": \
        { "x-blocks-transferable": "example-iot/link", "x-blocks-type-args": \
        [{ "type": "object", "properties": { "t": { "type": "number" } }, "required": ["t"] }] } } }
        """
    }

    func testModuleShadowedByAnyEmittedDeclarationIsAnError() throws {
        // A module is referenced as `Module.Type` from inside the namespace class, so a
        // top-level declaration the generated file emits shadows it.
        let cases = [
            ShadowCase("namespace class", module: "Api", methods: boundMethod),
            ShadowCase("Servers enum", module: "Servers", methods: boundMethod),
            ShadowCase(
                "component schema", module: "Widget", methods: boundMethod,
                components: #", "components": { "schemas": { "Widget": \#(inlineObjectSchema) } }"#
            ),
            ShadowCase("per-operation enum", module: "Get", methods: boundMethod),
            ShadowCase("inline result enum", module: "InlineResult", methods: inlineResultMethod)
        ]
        for shadowCase in cases {
            let spec = """
            {
                "openrpc": "1.3.2",
                "info": { "title": "test", "version": "1.0.0" },
                "methods": [\(shadowCase.methods)]\(shadowCase.components),
                "x-blocks-native-packages": { "schemaVersion": 1, "packages": \
            { "example-iot-native": { "platforms": { "swift": { "package": \
            { "identity": "example-iot-native", "product": "\(shadowCase.module)", \
            "module": "\(shadowCase.module)" } } } } } },
                "x-blocks-native-bindings": { "schemaVersion": 1, "bindings": \
            [\(binding(id: "link", tag: "example-iot/link", export: "link", arity: 1))] }
            }
            """
            XCTAssertThrowsError(try generate(from: spec), "\(shadowCase.label) must reject '\(shadowCase.module)'") { error in
                guard case CodegenError.invalidNativeCatalog(let detail) = error else {
                    return XCTFail("\(shadowCase.label): expected invalidNativeCatalog, got \(error)")
                }
                XCTAssertTrue(detail.contains("'\(shadowCase.module)'"), "\(shadowCase.label): got \(detail)")
            }
        }
    }

    func testEveryEmittedDeclarationGoesThroughEmitDeclaration() throws {
        let sources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/BlocksCodegen")
        let pattern = #"(\.append\(|\.insert\(|\+= \[)\s*"(\\\(indent\))?\s*"#
            + #"((?:public|private|internal|fileprivate|open|package|final|indirect)\s+)*"#
            + #"(class|struct|enum|actor|protocol|typealias)\s"#
        let regex = try NSRegularExpression(pattern: pattern)
        var offenders: [String] = []
        for file in try FileManager.default.contentsOfDirectory(at: sources, includingPropertiesForKeys: nil)
            where file.pathExtension == "swift" {
            for (number, line) in try String(contentsOf: file, encoding: .utf8).split(separator: "\n").enumerated()
                where regex.firstMatch(in: String(line), range: NSRange(line.startIndex..., in: line)) != nil {
                offenders.append("\(file.lastPathComponent):\(number + 1): \(line.trimmingCharacters(in: .whitespaces))")
            }
        }
        XCTAssertTrue(
            offenders.isEmpty,
            "a type declaration is appended without recording its name; call emitDeclaration instead:\n"
                + offenders.joined(separator: "\n")
        )
    }

    func testModelsFileImportsTheRuntimeItQualifies() throws {
        // A constrained component schema lands in Models.swift, where a qualified runtime
        // name does not inherit Api.swift's import.
        let spec = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [\(transferableMethod("getHandle", tag: "example-iot/device-handle"))],
            "components": { "schemas": { "Device": { "type": "object", "required": ["name"], \
        "properties": { "name": { "type": "string", "minLength": 1 } } } } },
            "x-blocks-native-packages": \(swiftPackagesCatalog()),
            "x-blocks-native-bindings": { "schemaVersion": 1, "bindings": [\(
            binding(id: "handle", tag: "example-iot/device-handle", export: "deviceHandle", arity: 0)
        )] }
        }
        """
        let output = try generate(from: spec)
        XCTAssertTrue(
            output.models.contains("BlocksRuntime.CodegenError"),
            "the constrained model must qualify the runtime error, got:\n\(output.models)"
        )
        XCTAssertTrue(
            output.models.contains("import BlocksRuntime"),
            "Models.swift must import what it qualifies, got:\n\(output.models)"
        )
    }

    func testModelsFileStaysUnqualifiedAndRuntimeFreeWithoutADeclaredModule() throws {
        let spec = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{ "name": "api.get", "params": [], \
        "result": { "name": "R", "schema": { "type": "string" } } }],
            "components": { "schemas": { "Device": { "type": "object", "required": ["name"], \
        "properties": { "name": { "type": "string", "minLength": 1 } } } } }
        }
        """
        let output = try generate(from: spec)
        XCTAssertTrue(output.models.contains("CodegenError"), "got:\n\(output.models)")
        XCTAssertFalse(
            output.models.contains("import BlocksRuntime"),
            "an unqualified models file must not gain the import, got:\n\(output.models)"
        )
    }

    func testTwoTagsMayShareOneExport() throws {
        let methods = [
            transferableMethod("getHandle", tag: "example-iot/device-handle"),
            transferableMethod("getHandleV2", tag: "example-iot/device-handle-v2")
        ].joined(separator: ", ")
        let output = try generate(from: catalogSpec(
            methods: methods,
            bindings: [
                binding(id: "handle", tag: "example-iot/device-handle", export: "deviceHandle", arity: 0),
                binding(id: "handle-v2", tag: "example-iot/device-handle-v2", export: "deviceHandle", arity: 0)
            ]
        ))
        XCTAssertEqual(
            output.api.components(separatedBy: "-> ExampleIotNative.DeviceHandle").count - 1, 2,
            "both tags must hydrate to the shared export, got:\n\(output.api)"
        )
    }

    func testAComponentNamedLikeTheQualifiedRuntimeModuleIsAnError() throws {
        for occupied in ["BlocksRuntime"] {
            let spec = """
            {
                "openrpc": "1.3.2",
                "info": { "title": "test", "version": "1.0.0" },
                "methods": [\(transferableMethod("getHandle", tag: "example-iot/device-handle"))],
                "components": { "schemas": { "\(occupied)": { "type": "object", \
            "required": ["n"], "properties": { "n": { "type": "string" } } } } },
                "x-blocks-native-packages": \(swiftPackagesCatalog()),
                "x-blocks-native-bindings": { "schemaVersion": 1, "bindings": [\(
                binding(id: "handle", tag: "example-iot/device-handle", export: "deviceHandle", arity: 0)
            )] }
            }
            """
            XCTAssertThrowsError(try generate(from: spec), occupied) { error in
                guard case CodegenError.invalidNativeCatalog(let detail) = error else {
                    return XCTFail("\(occupied): expected invalidNativeCatalog, got \(error)")
                }
                XCTAssertTrue(detail.contains("'\(occupied)'"), "\(occupied): got \(detail)")
            }
        }
    }

    func testAComponentNamedLikeTheRuntimeIsAcceptedWhenNothingIsQualified() throws {
        let spec = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{ "name": "api.get", "params": [], \
        "result": { "name": "R", "schema": { "type": "string" } } }],
            "components": { "schemas": { "BlocksRuntime": { "type": "object", \
        "required": ["n"], "properties": { "n": { "type": "string" } } } } }
        }
        """
        let output = try generate(from: spec)
        XCTAssertTrue(
            output.models.contains("public struct BlocksRuntime"),
            "an unqualified client can declare the name, got:\n\(output.models)"
        )
    }

    func testRuntimeReferencesAreQualifiedOnceADeclaredModuleIsImported() throws {
        // Reachable through the built-in path, whose type names are not module-qualified
        // by the binding.
        let methods = [
            transferableMethod("getFile", tag: "example-fb/download"),
            transferableMethod("builtin", tag: "file-bucket/download")
        ].joined(separator: ", ")
        let spec = catalogSpec(
            methods: methods,
            bindings: [binding(id: "fb", tag: "example-fb/download", export: "fileDownloadHandle", arity: 0)]
        )
        let output = try generate(from: spec)
        XCTAssertTrue(
            output.api.contains("-> BlocksRuntime.FileDownloadHandle"),
            "the built-in result must be qualified, got:\n\(output.api)"
        )
        XCTAssertTrue(
            output.api.contains("return try BlocksRuntime.FileDownloadHandle.fromJSON(descriptor)"),
            "the built-in hydration must be qualified, got:\n\(output.api)"
        )
        XCTAssertTrue(output.api.contains("private let client: BlocksRuntime.BlocksClient"), "got:\n\(output.api)")
        XCTAssertTrue(
            output.api.contains("-> ExampleIotNative.FileDownloadHandle"),
            "the declared result keeps its own module, got:\n\(output.api)"
        )
    }

    func testRuntimeReferencesStayUnqualifiedWithoutADeclaredModule() throws {
        // The doc fixes the built-in shape unqualified, so a spec importing no declared
        // module is byte-unchanged.
        let spec = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [\(transferableMethod("builtin", tag: "file-bucket/download"))]
        }
        """
        let output = try generate(from: spec)
        XCTAssertTrue(output.api.contains("-> FileDownloadHandle"), "got:\n\(output.api)")
        XCTAssertFalse(output.api.contains("BlocksRuntime.FileDownloadHandle"), "got:\n\(output.api)")
        XCTAssertTrue(output.api.contains("private let client: BlocksClient"), "got:\n\(output.api)")
    }

    func testDeclaredBindingEscapesTheTagInTheEmittedLiteral() throws {
        let oddTag = #"v/a\"b\\c"#
        let spec = catalogSpec(
            methods: transferableMethod("get", tag: oddTag),
            bindings: [binding(id: "odd", tag: oddTag, export: "deviceHandle", arity: 0)]
        )
        let output = try generate(from: spec)
        XCTAssertTrue(
            output.api.contains(#"BlocksRuntime.validateTransferableDescriptor(descriptor, expectedTag: "v/a\"b\\c")"#),
            "a declared binding's tag was not escaped for the emitted literal, got:\n\(output.api)"
        )
    }

    func testAGenericBindingWithNoTypeArgQualifiesItsFallbackPayload() throws {
        let method = """
        { "name": "api.get", "params": [], "result": { "name": "R", "schema": \
        { "x-blocks-transferable": "example-iot/link" } } }
        """
        let spec = catalogSpec(
            methods: method,
            bindings: [binding(id: "link", tag: "example-iot/link", export: "link", arity: 1)]
        )
        let output = try generate(from: spec)
        XCTAssertTrue(
            output.api.contains("-> ExampleIotNative.Link<BlocksRuntime.JSONValue>"),
            "the signature must qualify its fallback payload like the body does, got:\n\(output.api)"
        )
    }

    func testEmittedValidationErrorsAreQualifiedBesideADeclaredModule() throws {
        let method = """
        { "name": "api.get", "params": [{ "name": "input", "required": true, "schema": \
        { "type": "object", "properties": { "code": { "type": "string", "minLength": 2 } }, \
        "required": ["code"] } }], "result": { "name": "R", "schema": \
        { "x-blocks-transferable": "example-iot/handle" } } }
        """
        let spec = catalogSpec(
            methods: method,
            bindings: [binding(id: "handle", tag: "example-iot/handle", export: "handle", arity: 0)]
        )
        let output = try generate(from: spec)
        XCTAssertTrue(
            output.api.contains("throw BlocksRuntime.CodegenError.validation"),
            "a declared module may export CodegenError, so the throw must be qualified, got:\n\(output.api)"
        )
    }

    func testAModuleTheGeneratedSourceAlreadyImportsIsAnError() throws {
        let spec = catalogSpec(
            methods: transferableMethod("getDeviceHandle", tag: "example-iot/device-handle"),
            packages: """
            { "schemaVersion": 1, "packages": { "example-iot-native": { "platforms": { "swift": \
            { "package": { "identity": "example-iot-native", "product": "Foundation", \
            "module": "Foundation" } } } } } }
            """,
            bindings: [binding(id: "handle", tag: "example-iot/device-handle", export: "deviceHandle", arity: 0)]
        )
        XCTAssertThrowsError(try generate(from: spec)) { error in
            guard case CodegenError.invalidNativeCatalog(let detail) = error else {
                return XCTFail("expected invalidNativeCatalog, got \(error)")
            }
            XCTAssertTrue(detail.contains("already imports"), "got \(detail)")
        }
    }
}
