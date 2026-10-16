//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

// MARK: - Names next to spec names
//
// The generator declares names of its own beside the spec's: an operation's locals (`_params`, `request`, `result`,
// `descriptor`), the API class's `client` property, an operation's enum (`Send`), an open record's `attributes`, a
// hybrid arm's `challenge`, the API classes and `Servers`. When a spec name equals one, the generated name steps
// aside (`request_2`, `client_2`, `attributes_2`, `Servers_2`); a spec name is renamed only when Swift can't declare
// it (it isn't an identifier, or it sanitizes like a sibling), and then keeps its wire spelling through `CodingKeys`
// and escaped string literals. A parameter keeps its label but takes an internal name when the method body spells a
// type of its name (`JSONDecoder JSONDecoder_2: String`), or when it's `self`. A name that collides with nothing is
// unchanged.

/// The identifier a spec name takes before it's made unique: itself, or sanitized when it isn't an identifier.
func swiftIdentifierCandidate(_ name: String) -> String {
    isValidSwiftIdentifier(name) ? name : sanitizedSwiftName(name)
}

/// The identifier a lowerCamelCase spec-derived name takes (an enum value, a server), sanitized when it isn't one.
func swiftCamelCaseCandidate(_ name: String) -> String {
    swiftIdentifierCandidate(camelCase(name))
}

/// The types every API class spells by name (in its members' signatures and bodies, and in the types nested in its
/// operations' enums). An operation's enum declared inside the class with one of these names would shadow it.
let apiClassSpelledTypeNames: Set<String> = nestedShadowingTypeNames.union([
    "BlocksClient", "BlocksServer", "BlocksRequest", "RPCError", "JSONDecoder", "JSONSerialization",
    "Any", "Encodable", "Servers"
])

/// The types an operation's body spells by name. A parameter with one of these names takes an internal name.
let operationBodyTypeNames: Set<String> = [
    "BlocksClient", "BlocksRequest", "RPCError", "JSONDecoder", "JSONSerialization", "String", "Any", "Encodable",
    "RealtimeChannel", "FileDownloadHandle", "FileUploadHandle", "OIDCClient", "JSONValue"
]

/// The names an API class declares: its operations' functions and enums, and its `client` property.
struct APIClassNames {
    /// The function of each operation, by operation name (escaped).
    let functions: [String: String]
    /// The enum of each operation with nested types, by operation name.
    let enums: [String: String]
    /// The `BlocksClient` property: `client`, unless an operation is named that.
    let client: String
}

/// The names one operation's method uses: each parameter's label and the name its body reads it by, the locals,
/// and how the body reads the class's client.
struct OperationNames {
    /// Each parameter's argument label (escaped), in order.
    let labels: [String]
    /// Each parameter's name in the body (escaped): its label, or an internal name.
    let values: [String]
    let params: String
    let request: String
    let result: String
    let descriptor: String
    /// The class's client as the body reads it: `client`, or `self.client` when a parameter has its name.
    let client: String
    /// The client property's name.
    let clientProperty: String
    /// Whether a parameter hides the client property in the body.
    var clientIsHidden: Bool { client.hasPrefix("self.") }

    /// The parameter list: `label: Type`, or `label value: Type` with an internal name.
    func parameterDeclaration(_ index: Int) -> String {
        labels[index] == values[index] ? labels[index] : "\(labels[index]) \(values[index])"
    }
}

extension SwiftCodeGenerator {
    /// The Swift property name of each field of a record, by wire name (escaped). See `swiftIdentifiers`.
    func propertyNames(_ fields: [ResolvedField]) -> [String: String] {
        swiftPropertyNames(fields)
    }

    /// The Swift property name of `field` among a record's `fields`.
    func propertyName(_ field: ResolvedField, in fields: [ResolvedField]) -> String {
        propertyNames(fields)[field.name] ?? escapedSwiftName(field.name)
    }

    /// The property an open record keeps its extra keys in: `attributes`, unless a property has that name.
    func extrasPropertyName(_ fields: [ResolvedField]) -> String {
        var scope = SwiftNameScope(taken: Set(propertyNames(fields).values.map(unescapedSwiftName)))
        return scope.claim("attributes")
    }

    /// The property a hybrid arm keeps its nested union in: `challenge`, unless a property has that name.
    func embeddedPropertyName(_ fields: [ResolvedField]) -> String {
        var scope = SwiftNameScope(taken: Set(propertyNames(fields).values.map(unescapedSwiftName)))
        return scope.claim("challenge")
    }

    /// A `CodingKeys` case for a property: `case name`, or `case name = "wire"` when the name isn't the wire key.
    func codingKeyCase(_ name: String, wireName: String) -> String {
        name == wireName ? "case \(name)" : "case \(name) = \"\(swiftStringContent(wireName))\""
    }

    /// The `case` lines of a string enum: each value's lowerCamelCase name, sanitized and unique, with its raw value
    /// when that isn't the name.
    func enumCaseLines(_ values: [String], indent: String) -> [String] {
        let names = swiftIdentifiers(for: values, candidate: swiftCamelCaseCandidate)
        return zip(values, names).map { value, name in
            unescapedSwiftName(name) == value
                ? "\(indent)case \(name)"
                : "\(indent)case \(name) = \"\(swiftStringContent(value))\""
        }
    }

    /// A union's case for a variant: the variant's name in lowerCamelCase, escaped when it's a keyword.
    func unionCaseName(_ variant: UnionVariant) -> String {
        escapedSwiftName(camelCase(variant.name))
    }

    /// The `static let` name of each server in `Servers`, in order.
    func serverPropertyNames(_ servers: [ServerDefinition]) -> [String] {
        swiftIdentifiers(for: servers.map(\.name), candidate: swiftCamelCaseCandidate)
    }

    /// The class of each namespace, in order: its PascalCase name, stepping aside for a type declared at the top
    /// level (a component schema, `Servers`) and for another namespace's class.
    func apiClassNames(_ namespaces: [APINamespace], topLevelNames: Set<String>) -> [String] {
        var scope = SwiftNameScope(taken: topLevelNames.union(["Servers"]))
        return namespaces.map { scope.claim(specTypeName($0.name)) }
    }

    /// The names an API class declares for its operations.
    func apiClassMemberNames(_ namespace: APINamespace) -> APIClassNames {
        let operations = namespace.operations
        let functionNames = swiftIdentifiers(for: operations.map(\.name), candidate: swiftIdentifierCandidate)
        var members = SwiftNameScope(taken: Set(functionNames.map(unescapedSwiftName)))
        let client = members.claim("client")
        // An operation's enum steps aside for a type the class spells: a component schema an operation names, a
        // Swift or runtime type, `Servers`.
        var spelled = apiClassSpelledTypeNames
        for operation in operations {
            spelled.formUnion(topLevelTypeNames(spelledBy: operation))
        }
        var enumScope = SwiftNameScope(taken: members.taken.union(spelled))
        var enums: [String: String] = [:]
        for operation in operations where !operation.nestedTypes.isEmpty {
            enums[operation.name] = enumScope.claim(specTypeName(operation.name))
        }
        return APIClassNames(
            functions: Dictionary(zip(operations.map(\.name), functionNames), uniquingKeysWith: { first, _ in first }),
            enums: enums,
            client: client
        )
    }

    /// The names `operation`'s method uses. `bodyTypes` are the types its body spells beside the fixed ones (its
    /// result type, a channel's message type).
    func operationNames(_ operation: Operation, classNames: APIClassNames, bodyTypes: Set<String>) -> OperationNames {
        let labels = swiftIdentifiers(for: operation.parameters.map(\.name), candidate: swiftIdentifierCandidate)
        var scope = SwiftNameScope(taken: Set(labels.map(unescapedSwiftName)))
        let hidden = operationBodyTypeNames.union(bodyTypes).union(["self"])
        let values = labels.map { label -> String in
            let bare = unescapedSwiftName(label)
            return hidden.contains(bare) ? escapedSwiftName(scope.claim(bare)) : label
        }
        let bodyNames = Set(values.map(unescapedSwiftName))
        let params = scope.claim("_params")
        let request = scope.claim("request")
        let result = scope.claim("result")
        let descriptor = scope.claim("descriptor")
        return OperationNames(
            labels: labels, values: values, params: params, request: request, result: result, descriptor: descriptor,
            client: bodyNames.contains(classNames.client) ? "self.\(classNames.client)" : classNames.client,
            clientProperty: classNames.client
        )
    }

    /// The identifiers a type name spells outside a qualified path (`Send.Result` spells `Send`,
    /// `RealtimeChannel<Feed.ResultMessage>` spells `RealtimeChannel` and `Feed`, `[String: Item]` spells `String`
    /// and `Item`).
    func spelledRootIdentifiers(_ typeName: String) -> Set<String> {
        var identifiers: Set<String> = []
        var current = ""
        var afterDot = false
        for char in typeName + " " {
            if char.isLetter || char.isNumber || char == "_" {
                current.append(char)
                continue
            }
            if !current.isEmpty, !afterDot { identifiers.insert(current) }
            current = ""
            afterDot = char == "."
        }
        return identifiers
    }

    /// The top-level types an operation names inside its API class: in its signature and in the types nested in its
    /// enum, the names that aren't one of its nested types.
    private func topLevelTypeNames(spelledBy operation: Operation) -> Set<String> {
        var nested: Set<String> = []
        var types: [ResolvedType] = operation.parameters.map(\.type) + [operation.result.type]
        func collect(_ nodes: [NestedTypeNode]) {
            for node in nodes {
                nested.insert(node.name)
                types.append(node.type)
                collect(node.children)
            }
        }
        collect(operation.nestedTypes)
        var names: Set<String> = []
        var visited: Set<String> = []
        func walk(_ type: ResolvedType) {
            switch type {
            case .record(let name, let fields, let additionalPropertiesType, let embeddedUnion):
                names.insert(name)
                guard visited.insert("record:\(name)").inserted else { return }
                fields.forEach { walk($0.type) }
                additionalPropertiesType.map(walk)
                embeddedUnion.map(walk)
            case .union(let name, let variants, _):
                names.insert(name)
                guard visited.insert("union:\(name)").inserted else { return }
                for variant in variants {
                    names.insert(variant.payloadTypeName ?? variant.name)
                    variant.fields.forEach { walk($0.type) }
                    variant.additionalPropertiesType.map(walk)
                    variant.embeddedUnion.map(walk)
                    variant.valueType.map(walk)
                    collect(variant.nestedTypes)
                }
            case .enum(let name, _), .typeReference(let name):
                names.insert(name)
            case .list(let element, _):
                walk(element)
            case .map(let value):
                walk(value)
            case .nullable(let inner):
                walk(inner)
            case .transferable(_, let typeArgs):
                names.formUnion(spelledRootIdentifiers(swiftTypeNameNoEmit(type)))
                typeArgs.forEach(walk)
            case .primitive, .formattedType:
                names.formUnion(spelledRootIdentifiers(swiftTypeNameNoEmit(type)))
            }
        }
        var index = 0
        while index < types.count {
            walk(types[index])
            index += 1
        }
        return names.subtracting(nested)
    }
}

// MARK: - An operation's request

extension SwiftCodeGenerator {
    /// The lines that build an operation's `BlocksRequest` (`let request = BlocksRequest(…)`, after its `_params`).
    /// Params are positional on the server, as the TypeScript client sends them: every argument up to the last
    /// required one is in its slot (a nil optional one encodes as `null`); a trailing optional one is appended when
    /// it's set, as `JSONValue.null` when a later one is (`["a",null,"c"]`), and trailing unset ones are left off.
    func requestLines(_ operation: Operation, names: OperationNames, methodLiteral: String) -> [String] {
        let request = names.request
        guard let last = operation.parameters.last else {
            return ["        let \(request) = BlocksRequest(method: \"\(methodLiteral)\", params: [], id: BlocksRequest.nextId())"]
        }
        guard !last.required else {
            let arrayElements = names.values.joined(separator: ", ")
            return [
                "        let \(request) = BlocksRequest(method: \"\(methodLiteral)\", params: [\(arrayElements)], id: BlocksRequest.nextId())"
            ]
        }
        // Find the boundary: required params come first, then optional trailing ones
        let lastRequiredIdx = operation.parameters.lastIndex(where: { $0.required }) ?? -1
        let params = names.params
        var lines: [String] = []
        if lastRequiredIdx < 0 {
            lines.append("        var \(params): [any Encodable] = []")
        } else {
            let reqElems = names.values[0 ... lastRequiredIdx].joined(separator: ", ")
            lines.append("        var \(params): [any Encodable] = [\(reqElems)]")
        }
        // Append optional params in order, stopping at the first nil from the end
        // We must append in order (can't skip a middle one), so append all non-nil
        // trailing params up to the last non-nil one.
        let trailing = Array(names.values[(lastRequiredIdx + 1)...])
        for (offset, safe) in trailing.enumerated() {
            let later = trailing[(offset + 1)...]
            let append = "if let \(safe) { \(params).append(\(safe)) }"
            if later.isEmpty {
                lines.append("        \(append)")
            } else {
                let anyLater = later.map { "\($0) != nil" }.joined(separator: " || ")
                lines.append("        \(append) else if \(anyLater) { \(params).append(JSONValue.null) }")
            }
        }
        lines.append("        let \(request) = BlocksRequest(method: \"\(methodLiteral)\", params: \(params), id: BlocksRequest.nextId())")
        return lines
    }
}
