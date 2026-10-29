//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

/// The concrete runtime type each known tag maps to; `isGeneric` wraps the first
/// type argument (`RealtimeChannel<T>`). The tag Set and type printers derive from this.
let knownTransferableBindings: [String: (base: String, isGeneric: Bool)] = [
    "realtime/channel": ("RealtimeChannel", true),
    "file-bucket/download": ("FileDownloadHandle", false),
    "file-bucket/upload": ("FileUploadHandle", false),
    "oidc/client": ("OIDCClient", false)
]

let knownTransferableTags: Set<String> = Set(knownTransferableBindings.keys)

let transferableFactoriesByABI: [String: String] = [
    "blocks-transferable-v1": "fromBlocksDescriptor"
]

let nativeCatalogSchemaVersion = 1

let transferableBindingKind = "transferable"

let maxGenericArity = 1

/// Illegal in a qualified type position: `M.Type` and `M.Protocol` parse as metatype
/// syntax whatever their arity, and `Any` cannot name a declaration at all.
let typeNamesIllegalWhenQualified: Set<String> = ["Type", "Protocol", "Any"]

struct DeclaredTransferableBinding {
    let module: String
    /// Module-qualified, as `BlocksRuntime.UnknownTransferable` already is.
    let base: String
    let factory: String
    let isGeneric: Bool
}

/// Two tags may share one export; a different export or arity cannot share its type.
/// Keyed by module, so two catalog keys naming one package agree here and a differing
/// identity or product does not: no dependency set provides one module twice.
struct SwiftPackageRef: Equatable {
    let identity: String?
    let product: String?
}

struct TypeNameClaim: Equatable {
    let package: String
    let export: String
    let arity: Int
}

struct ResolvedDeclaredBindings {
    var bindings: [String: DeclaredTransferableBinding] = [:]
    var unboundCauses: [String: String] = [:]
    var warnings: [String] = []
}

/// A built-in tag is dropped rather than rejected: it keeps the hard-coded path in
/// `SwiftCodeGenerator`'s `switch blocksType`.
///
/// Six of the rules below coincide with producer checks because Swift needs them
/// for its own emission, not to re-validate; D-020 records which, and why.
func resolveDeclaredTransferableBindings(
    packages: NativePackagesCatalog?,
    bindings: NativeBindingsCatalog?,
    optOutPackages: Set<String>
) throws -> ResolvedDeclaredBindings {
    if let packages, packages.schemaVersion != nativeCatalogSchemaVersion {
        throw CodegenError.invalidNativeCatalog(
            "x-blocks-native-packages declares schemaVersion \(packages.schemaVersion), expected \(nativeCatalogSchemaVersion)"
        )
    }
    try validateDeclaredSwiftModules(packages)
    let optOutWarnings = validateOptOutPackages(optOutPackages, packages: packages)
    guard let bindings else { return ResolvedDeclaredBindings(warnings: optOutWarnings) }
    if bindings.schemaVersion != nativeCatalogSchemaVersion {
        throw CodegenError.invalidNativeCatalog(
            "x-blocks-native-bindings declares schemaVersion \(bindings.schemaVersion), expected \(nativeCatalogSchemaVersion)"
        )
    }

    // Swift holds AWSBLOCKS-NATIVE-001 and 003 through 006; 002 is a Dart diagnostic.
    var resolved: [String: DeclaredTransferableBinding] = [:]
    var boundTags: Set<String> = []
    var typeNameClaimants: [String: TypeNameClaim] = [:]
    var moduleOwners: [String: (key: String, ref: SwiftPackageRef)] = [:]
    var unboundCauses: [String: String] = [:]
    var warnings: [String] = optOutWarnings
    for binding in bindings.bindings ?? [] {
        guard binding.kind == transferableBindingKind else {
            // `kind` is an open enumeration, so an unrecognised one still generates.
            warnings.append(
                "AWSBLOCKS-NATIVE-004: binding '\(binding.id)' declares kind '\(binding.kind)', "
                    + "which schema \(nativeCatalogSchemaVersion) does not define; ignored on swift."
            )
            continue
        }
        guard let entry = packages?.packages?[binding.package] else {
            throw CodegenError.invalidNativeCatalog(
                "binding '\(binding.id)' names package '\(binding.package)', which x-blocks-native-packages does not declare"
            )
        }
        guard let factory = transferableFactoriesByABI[binding.abi] else {
            throw CodegenError.invalidNativeCatalog(
                "binding '\(binding.id)' declares unknown factory ABI '\(binding.abi)'"
            )
        }
        let arity = binding.genericArity ?? 0
        guard arity >= 0, arity <= maxGenericArity else {
            throw CodegenError.invalidNativeCatalog(
                "binding '\(binding.id)' declares genericArity \(arity), outside 0...\(maxGenericArity) in schema \(nativeCatalogSchemaVersion)"
            )
        }
        guard boundTags.insert(binding.tag).inserted else {
            throw CodegenError.invalidNativeCatalog("tag '\(binding.tag)' is bound by more than one binding")
        }
        guard !binding.tag.isEmpty else {
            // `validateTransferableDescriptor` rejects an empty received tag before
            // comparing, so an empty expected tag can never be satisfied.
            throw CodegenError.invalidNativeCatalog("binding '\(binding.id)' declares an empty tag")
        }
        let typeName = upperCamelCase(binding.export)
        guard isValidSwiftIdentifier(typeName),
              !swiftKeywords.contains(typeName),
              !typeNamesIllegalWhenQualified.contains(typeName)
        else {
            throw CodegenError.invalidNativeCatalog(
                "binding '\(binding.id)' declares export '\(binding.export)', which does not name a Swift type"
            )
        }
        guard !knownTransferableTags.contains(binding.tag) else {
            warnings.append(
                "AWSBLOCKS-NATIVE-005: binding '\(binding.id)' declares built-in tag '\(binding.tag)', "
                    + "which cannot be re-bound; ignored on swift."
            )
            continue
        }
        if optOutPackages.contains(binding.package) {
            unboundCauses[binding.tag] = "package '\(binding.package)' is opted out"
            continue
        }
        guard let swiftPackage = entry.platforms?.swift?.package else {
            unboundCauses[binding.tag] = "package '\(binding.package)' declares no swift platform"
            continue
        }
        // Reached only by an emitted binding, which is why the drops precede it: a
        // dropped binding contributes no import and no factory call, so nothing collides.
        let packageRef = SwiftPackageRef(identity: swiftPackage.identity, product: swiftPackage.product)
        if let owner = moduleOwners[swiftPackage.module], owner.ref != packageRef {
            throw CodegenError.invalidNativeCatalog(
                "packages '\(owner.key)' and '\(binding.package)' declare Swift module "
                    + "'\(swiftPackage.module)' with different package metadata; "
                    + "no dependency set can satisfy both"
            )
        }
        moduleOwners[swiftPackage.module] = (key: binding.package, ref: packageRef)
        let resolvedName = "\(swiftPackage.module).\(typeName)"
        let claimant = TypeNameClaim(package: binding.package, export: binding.export, arity: arity)
        if let prior = typeNameClaimants[resolvedName], prior != claimant {
            throw CodegenError.invalidNativeCatalog(
                "binding '\(binding.id)' resolves to \(resolvedName), already resolved by export "
                    + "'\(prior.export)' in package '\(prior.package)' at generic arity \(prior.arity)"
            )
        }
        typeNameClaimants[resolvedName] = claimant
        resolved[binding.tag] = DeclaredTransferableBinding(
            module: swiftPackage.module,
            base: "\(swiftPackage.module).\(typeName)",
            factory: factory,
            isGeneric: arity > 0
        )
    }
    return ResolvedDeclaredBindings(bindings: resolved, unboundCauses: unboundCauses, warnings: warnings)
}

func unreferencedPackageWarnings(packages: NativePackagesCatalog?, bindings: NativeBindingsCatalog?) -> [String] {
    guard let packages else { return [] }
    let referenced = Set(
        (bindings?.bindings ?? [])
            .filter { $0.kind == transferableBindingKind }
            .map(\.package)
    )
    return (packages.packages ?? [:]).keys.sorted()
        .filter { !referenced.contains($0) }
        .map { "AWSBLOCKS-NATIVE-003: native package '\($0)' is declared but no binding references it; not imported on swift." }
}

func declaredModuleImports(_ model: CodegenModel) -> [String] {
    var modules: [String] = []
    for namespace in model.apiNamespaces {
        for operation in namespace.operations {
            var result = operation.result.type
            if case .nullable(let inner) = result { result = inner }
            guard case .transferable(let blocksType, _) = result,
                  let declared = model.declaredTransferableBindings[blocksType],
                  !modules.contains(declared.module) else { continue }
            modules.append(declared.module)
        }
    }
    return modules.sorted()
}

/// Sorted by key so a spec with two malformed modules always names the same one.
func validateDeclaredSwiftModules(_ packages: NativePackagesCatalog?) throws {
    guard let declared = packages?.packages else { return }
    for key in declared.keys.sorted() {
        guard let module = declared[key]?.platforms?.swift?.package.module else { continue }
        guard isValidSwiftIdentifier(module),
              !swiftKeywords.contains(module),
              !typeNamesIllegalWhenQualified.contains(module)
        else {
            throw CodegenError.invalidNativeCatalog(
                "package '\(key)' declares Swift module '\(module)', which is not usable as `import <module>`"
            )
        }
        // The generated source imports these unconditionally, so a package claiming one
        // emits no import of its own and leaves every runtime name unqualified.
        guard !alwaysEmittedImports.contains(module) else {
            throw CodegenError.invalidNativeCatalog(
                "package '\(key)' declares Swift module '\(module)', which the generated source already imports"
            )
        }
    }
}

/// An opt-out is build configuration, not spec metadata, so one that matches nothing is
/// the author's own typo rather than a malformed catalog.
func validateOptOutPackages(_ optOutPackages: Set<String>, packages: NativePackagesCatalog?) -> [String] {
    let declared = packages?.packages ?? [:]
    return optOutPackages.sorted().filter { declared[$0] == nil }.map {
        declared.isEmpty
            ? "AWSBLOCKS-NATIVE-006: opted-out package '\($0)' has nothing to opt out of; "
            + "the spec declares no native packages."
            : "AWSBLOCKS-NATIVE-006: opted-out package '\($0)' has nothing to opt out of; "
            + "it is not declared in x-blocks-native-packages."
    }
}

let alwaysEmittedImports: Set<String> = ["Foundation", "BlocksRuntime"]

func declaredResultTypeName(
    _ type: ResolvedType,
    declared: [String: DeclaredTransferableBinding],
    fallbackMessageType: String,
    renderArg: (ResolvedType) -> String
) -> String? {
    var inner = type
    var optional = false
    if case .nullable(let wrapped) = type {
        inner = wrapped
        optional = true
    }
    guard case .transferable(let blocksType, let typeArgs) = inner,
          let binding = declared[blocksType] else { return nil }
    let name = declaredTypeName(binding, messageType: typeArgs.first.map(renderArg) ?? fallbackMessageType)
    return optional ? "\(name)?" : name
}

func upperCamelCase(_ export: String) -> String {
    export.split(whereSeparator: { $0 == "_" || $0 == "-" || $0 == "." || $0 == ":" })
        .map { segment in
            if segment.allSatisfy({ $0.isUppercase || $0.isNumber }), segment.count > 1 {
                return segment.prefix(1).uppercased() + segment.dropFirst().lowercased()
            }
            return segment.prefix(1).uppercased() + segment.dropFirst()
        }
        .joined()
}

func declaredTypeName(_ declared: DeclaredTransferableBinding, messageType: String) -> String {
    declared.isGeneric ? "\(declared.base)<\(messageType)>" : declared.base
}

/// Called only for a tag with no built-in binding. The generic belongs to the TYPE, not the
/// method: `Module.Type<Payload>.fromBlocksDescriptor(…)`, since a `static func
/// fromBlocksDescriptor<T>` on a non-generic type fails with `cannot specialize non-generic type`.
func transferableHydrationLines(
    declared: DeclaredTransferableBinding?,
    tagLiteral: String,
    messageType: String,
    runtimePrefix: String
) -> [String] {
    guard let declared else {
        return ["        return try BlocksRuntime.UnknownTransferable.fromJSON(descriptor, expectedTag: \(tagLiteral))"]
    }
    let validated = "\(runtimePrefix)validateTransferableDescriptor(descriptor, expectedTag: \(tagLiteral))"
    let typeName = declaredTypeName(declared, messageType: messageType)
    guard declared.isGeneric else {
        return [
            "        return try \(typeName).\(declared.factory)(",
            "            \(validated)",
            "        )"
        ]
    }
    return [
        "        return try \(typeName).\(declared.factory)(",
        "            \(validated)",
        "        ) { data in",
        "            try JSONDecoder().decode(\(messageType).self, from: data)",
        "        }"
    ]
}

// MARK: - Resolved Codegen Model

/// A fully resolved, language-independent type ready for translation to Swift.
indirect enum ResolvedType {
    case primitive(PrimitiveKind, constraints: Constraints = .empty)
    /// A type whose Swift representation is determined by the JSON Schema
    /// `format` keyword (e.g. `format: "date-time"` → `Date`).
    case formattedType(FormatKind, constraints: Constraints = .empty)
    /// Named record. When `additionalPropertiesType` is non-nil the record is
    /// "open" — the spec declared `T & Record<string, V>`. Codegen emits an
    /// `attributes: [String: V]` field and overrides Codable so that map
    /// flattens at the JSON top level. When `embeddedUnion` is set, the
    /// record carries an inner discriminated union flattened at the same
    /// JSON envelope (one `oneOf` arm holds outer fields + nested oneOf —
    /// see Cognito's regrouped `confirmSignIn` arm).
    case record(name: String, fields: [ResolvedField], additionalPropertiesType: ResolvedType?, embeddedUnion: ResolvedType?)
    case `enum`(name: String, values: [String])
    case list(elementType: ResolvedType, constraints: Constraints = .empty)
    case nullable(inner: ResolvedType)
    case union(name: String, variants: [UnionVariant], discriminator: DiscriminatorInfo?)
    case typeReference(name: String)
    case transferable(blocksType: String, typeArgs: [ResolvedType])
    case map(valueType: ResolvedType)
}

/// Format keyword mappings that produce a non-`String` Swift type.
enum FormatKind {
    case dateTime  // → Foundation.Date
    case date      // → Foundation.Date (via ISO 8601 day-only)
    case time      // → String (Foundation has no time-only type)
    case uuid      // → Foundation.UUID
    case uri       // → Foundation.URL
}

/// JSON Schema constraint annotations carried alongside a primitive / list type.
/// Code generation may emit `precondition` checks at construct time when these
/// are set; today they are decoded but only the `format` field is consumed
/// (mapped into `ResolvedType.formattedType` upstream).
struct Constraints: Equatable {
    let format: String?
    let minLength: Int?
    let maxLength: Int?
    let pattern: String?
    let minimum: Double?
    let maximum: Double?
    let exclusiveMinimum: Double?
    let exclusiveMaximum: Double?
    let multipleOf: Double?
    let minItems: Int?
    let maxItems: Int?

    init(
        format: String? = nil,
        minLength: Int? = nil,
        maxLength: Int? = nil,
        pattern: String? = nil,
        minimum: Double? = nil,
        maximum: Double? = nil,
        exclusiveMinimum: Double? = nil,
        exclusiveMaximum: Double? = nil,
        multipleOf: Double? = nil,
        minItems: Int? = nil,
        maxItems: Int? = nil
    ) {
        self.format = format
        self.minLength = minLength
        self.maxLength = maxLength
        self.pattern = pattern
        self.minimum = minimum
        self.maximum = maximum
        self.exclusiveMinimum = exclusiveMinimum
        self.exclusiveMaximum = exclusiveMaximum
        self.multipleOf = multipleOf
        self.minItems = minItems
        self.maxItems = maxItems
    }

    static let empty = Constraints()

    var isEmpty: Bool { self == Constraints.empty }
}

struct ResolvedField {
    let name: String
    let type: ResolvedType
    let required: Bool
    let description: String?
    /// `default` value from the spec, encoded as raw JSON. Emitted as a Swift
    /// literal default when present (string / number / boolean / null only).
    let defaultValue: String?

    init(name: String, type: ResolvedType, required: Bool, description: String? = nil, defaultValue: String? = nil) {
        self.name = name
        self.type = type
        self.required = required
        self.description = description
        self.defaultValue = defaultValue
    }
}

struct UnionVariant {
    let name: String
    let fields: [ResolvedField]
    let discriminatorValue: String?
    /// Set when the variant payload is an existing named type (e.g. another
    /// union or a typeReference) rather than a fresh inline record. Codegen
    /// uses this to emit `case foo(ExistingType)` instead of synthesizing
    /// a new struct with `fields`.
    let payloadTypeName: String?
    /// Open-shape value type (e.g. `String` for `Record<string, string>`)
    /// when the variant's spec entry carried `additionalProperties`.
    /// Propagates so the synthesized variant struct gets the same
    /// `attributes: [String: V]` treatment as a top-level open record.
    let additionalPropertiesType: ResolvedType?
    /// Inner discriminated alternative whose fields flatten into the same
    /// JSON envelope (regrouped union arm). Codegen emits a merged Codable
    /// for the synthesized variant struct.
    let embeddedUnion: ResolvedType?
    /// Types declared inside this variant's fields that should be scoped
    /// under the variant struct (e.g. `NextStep` inside `IsSignedInFalse`).
    let nestedTypes: [NestedTypeNode]

    init(name: String, fields: [ResolvedField], discriminatorValue: String? = nil, payloadTypeName: String? = nil, additionalPropertiesType: ResolvedType? = nil, embeddedUnion: ResolvedType? = nil, nestedTypes: [NestedTypeNode] = []) {
        self.name = name
        self.fields = fields
        self.discriminatorValue = discriminatorValue
        self.payloadTypeName = payloadTypeName
        self.additionalPropertiesType = additionalPropertiesType
        self.embeddedUnion = embeddedUnion
        self.nestedTypes = nestedTypes
    }
}

struct DiscriminatorInfo {
    let fieldName: String
    let variants: [String: String] // discriminator value → variant name
}

// MARK: - Operations

struct OperationParameter {
    let name: String
    let type: ResolvedType
    let required: Bool
    let description: String?

    init(name: String, type: ResolvedType, required: Bool, description: String? = nil) {
        self.name = name
        self.type = type
        self.required = required
        self.description = description
    }
}

struct OperationResult {
    let type: ResolvedType
    let description: String?

    init(type: ResolvedType, description: String? = nil) {
        self.type = type
        self.description = description
    }
}

struct Operation {
    let name: String
    let parameters: [OperationParameter]
    let result: OperationResult
    let description: String?
    let nestedTypes: [NestedTypeNode]

    init(name: String, parameters: [OperationParameter], result: OperationResult, description: String? = nil, nestedTypes: [NestedTypeNode] = []) {
        self.name = name
        self.parameters = parameters
        self.result = result
        self.description = description
        self.nestedTypes = nestedTypes
    }
}

struct NestedTypeNode {
    let name: String
    let type: ResolvedType
    let children: [NestedTypeNode]

    init(name: String, type: ResolvedType, children: [NestedTypeNode] = []) {
        self.name = name
        self.type = type
        self.children = children
    }
}

struct APINamespace {
    let name: String
    let operations: [Operation]
}

// MARK: - Type Definitions

struct TypeDefinition {
    let name: String
    let type: ResolvedType
    let shortName: String

    init(name: String, type: ResolvedType, shortName: String? = nil) {
        self.name = name
        self.type = type
        self.shortName = shortName ?? name
    }
}

// MARK: - Root Model

public struct CodegenModel {
    let apiNamespaces: [APINamespace]
    let typeDefinitions: [TypeDefinition]
    let servers: [ServerDefinition]
    let declaredTransferableBindings: [String: DeclaredTransferableBinding]
    let unboundTransferableCauses: [String: String]
    let nativeCatalogWarnings: [String]
}
