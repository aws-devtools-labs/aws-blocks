//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

// MARK: - String Helpers

// Grounded in the Swift Reference § Keywords and Punctuation.
// Only true reserved keywords that cannot appear bare as identifiers.
// Contextual modifiers (final, required, override, lazy, weak, etc.)
// compile bare as struct field names and are intentionally excluded.
let swiftKeywords: Set<String> = [
    // Declarations
    "class", "struct", "enum", "protocol", "func", "var", "let",
    "import", "typealias", "associatedtype", "init", "deinit",
    "subscript", "operator", "precedencegroup", "extension",
    "static", "indirect",
    // Statements
    "if", "else", "switch", "case", "default", "for", "while",
    "repeat", "do", "break", "continue", "return", "fallthrough",
    "guard", "defer", "where", "in",
    // Expressions & types
    "as", "is", "try", "throw", "throws", "rethrows", "catch",
    "self", "Self", "super", "inout", "some", "any",
    "async", "await",
    // Access control (reserved, not contextual modifiers)
    "internal", "private", "public", "fileprivate",
    // Literals
    "true", "false", "nil",
    // Used as keyword in identifier position
    "type"
]

/// Type names that collide with Swift standard library, Foundation, or SwiftUI types.
let reservedTypeNames: Set<String> = [
    "State", "Type", "Method", "Error", "Result", "Action",
    "View", "Body", "Content", "Image", "Text", "Button",
    "List", "Group", "Section", "Form", "Label", "Picker",
    "Color", "Font", "Path", "Shape", "Scene", "App",
    "Binding", "Published", "Observable", "Environment",
    "Any", "AnyObject", "Optional", "Array", "Dictionary", "Set"
]

/// PascalCase string transformer. Splits on `-`, `.`, and `:` (always); preserves
/// underscores so deliberately-namespaced names like `Fields_SignUp` survive.
/// Each segment between underscores is independently PascalCased so
/// `fields_signUp` becomes `Fields_SignUp` (not `FieldsSignUp`, which would
/// collide with `Fields_SignUp` from the spec's component schemas).
/// Splitting on `:` lets Cognito custom-attribute names like `custom:email`
/// survive into a Swift-legal type name (`CustomEmail`).
///
/// Exception: SCREAMING_SNAKE_CASE strings (all uppercase + digits + underscores)
/// collapse underscores so `CONFIRM_SIGN_UP` → `ConfirmSignUp`.
func pascalCase(_ input: String) -> String {
    let isScreamingSnake = input.contains("_") && input.allSatisfy { $0.isUppercase || $0.isNumber || $0 == "_" }
    if isScreamingSnake {
        return input.split(separator: "_")
            .map { segment in
                segment.prefix(1).uppercased() + segment.dropFirst().lowercased()
            }
            .joined()
    }
    return input.split(separator: "_", omittingEmptySubsequences: false)
     .map { underscorePart -> String in
         underscorePart.split(separator: "-")
             .flatMap { $0.split(separator: ".") }
             .flatMap { $0.split(separator: ":") }
             .map { segment in
                 if segment.allSatisfy({ $0.isUppercase || $0.isNumber }) && segment.count > 1 {
                     return segment.prefix(1).uppercased() + segment.dropFirst().lowercased()
                 }
                 return segment.prefix(1).uppercased() + segment.dropFirst()
             }
             .joined()
     }
     .joined(separator: "_")
}

/// Names a union variant from its discriminator field + value.
/// Boolean discriminators (`isSignedIn: true`) become `IsSignedInTrue` / `IsSignedInFalse`
/// to avoid collisions. String discriminators use the value directly.
func variantNameFromDiscriminator(fieldName: String, value: String) -> String {
    if value == "true" || value == "false" {
        return pascalCase(fieldName) + pascalCase(value)
    }
    return pascalCase(value)
}

func camelCase(_ input: String) -> String {
    let pascal = pascalCase(input)
    return pascal.prefix(1).lowercased() + pascal.dropFirst()
}

func singularize(_ input: String) -> String {
    if input.hasSuffix("s") && !input.hasSuffix("ss") {
        return String(input.dropLast())
    }
    return input
}

func swiftMethodName(_ rpcName: String) -> String {
    let parts = rpcName.split(separator: ".", maxSplits: 1)
    if parts.count > 1 {
        return String(parts[1])
    }
    return camelCase(rpcName)
}

/// Returns a safe Swift type name, prefixing with parentName if the name collides
/// with a reserved Swift/SwiftUI type. If no parent is available, appends "Value" suffix.
func safeTypeName(_ name: String, parentName: String?) -> String {
    if reservedTypeNames.contains(name) {
        if let parent = parentName, !parent.isEmpty {
            return parent + name
        }
        return name + "Value"
    }
    return name
}

/// Returns true if `name` is a valid Swift identifier:
/// starts with letter/underscore, rest are letters/digits/underscores.
func isValidSwiftIdentifier(_ name: String) -> Bool {
    guard let first = name.first else { return false }
    if !(first.isLetter || first == "_") { return false }
    for char in name.dropFirst() where !(char.isLetter || char.isNumber || char == "_") {
        return false
    }
    return true
}

/// Sanitize an arbitrary spec property name into a Swift-legal identifier.
/// Replaces illegal chars with underscores and prefixes a leading underscore
/// when the name starts with a digit or is empty. Used for record field names
/// like `custom:email` (Cognito attributes) which are valid JSON keys but
/// not valid Swift property names.
func sanitizedSwiftName(_ name: String) -> String {
    if name.isEmpty { return "_unnamed" }
    var result = ""
    for (idx, char) in name.enumerated() {
        if char.isLetter || char == "_" || (idx > 0 && char.isNumber) {
            result.append(char)
        } else {
            result.append("_")
        }
    }
    if let first = result.first, first.isNumber {
        result = "_" + result
    }
    return result
}

/// Escape a Swift identifier for use as a property/parameter name.
/// Wraps Swift keywords in backticks and sanitizes illegal characters.
func escapedSwiftName(_ name: String) -> String {
    let safe = isValidSwiftIdentifier(name) ? name : sanitizedSwiftName(name)
    if swiftKeywords.contains(safe) {
        return "`\(safe)`"
    }
    return safe
}

/// Keep a diagnostic on one log line even if a spec-supplied value carries a newline.
func escapedForDiagnostic(_ value: String) -> String {
    value
        .replacingOccurrences(of: "\n", with: "\\n")
        .replacingOccurrences(of: "\r", with: "\\r")
}

// MARK: - Entry-point names

/// Members of the generated `Blocks`, plus names `blocks.<name>` cannot reach without backticks.
let blocksMemberNames: Set<String> = ["client", "server", "close", "self", "init"]

/// Names no namespace class may take: types the generated files declare or name unqualified,
/// the modules they qualify with, and keywords no class can be named.
let reservedNamespaceClassNames: Set<String> = [
    "Blocks", "Servers", "BlocksRuntime", "Foundation",
    "BlocksClient", "BlocksServer", "BlocksRequest", "RPCError", "CodegenError", "JSONValue",
    "RealtimeChannel", "FileDownloadHandle", "FileUploadHandle", "OIDCClient",
    "Sendable", "CaseIterable", "URLSession",
    "String", "Int", "Double", "Bool", "Date", "UUID", "URL", "Void", "Set", "Error",
    "Codable", "Encodable", "Decoder", "Encoder", "CodingKey", "DecodingError", "JSONDecoder", "JSONSerialization",
    "Self", "Any"
]

/// Names a spec model can't take: the entry point and servers the API file declares, and the module it qualifies with.
let reservedModelNames: Set<String> = ["Blocks", "Servers", "BlocksRuntime"]

/// Class name per namespace. A reserved or already claimed name gets an `Api` suffix;
/// names that need no change claim first, so a rename never takes another's name.
func namespaceClassNames(_ namespaces: [String]) -> [String: String] {
    var names: [String: String] = [:]
    var taken = reservedNamespaceClassNames
    for namespace in namespaces where taken.insert(pascalCase(namespace)).inserted {
        names[namespace] = pascalCase(namespace)
    }
    for namespace in namespaces where names[namespace] == nil {
        var name = pascalCase(namespace) + "Api"
        while !taken.insert(name).inserted {
            name += "Api"
        }
        names[namespace] = name
    }
    return names
}

/// The `Blocks` property a namespace would get without collisions: camelCased, leading underscores dropped.
func naturalAccessorName(_ namespace: String) -> String {
    let trimmed = String(namespace.drop { $0 == "_" })
    let name = camelCase(trimmed.isEmpty ? namespace : trimmed)
    return isValidSwiftIdentifier(name) ? name : sanitizedSwiftName(name)
}

/// Unescaped `Blocks` property per namespace. A `Blocks` member or an already claimed name gets
/// an `Api` suffix; names that need no change claim first, so a rename never takes another's name.
func namespaceAccessorNames(_ namespaces: [String]) -> [String: String] {
    var names: [String: String] = [:]
    var taken = blocksMemberNames
    for namespace in namespaces where naturalAccessorName(namespace) == camelCase(namespace) {
        if taken.insert(camelCase(namespace)).inserted {
            names[namespace] = camelCase(namespace)
        }
    }
    for namespace in namespaces where names[namespace] == nil {
        var name = naturalAccessorName(namespace)
        while taken.contains(name) {
            name += "Api"
        }
        names[namespace] = name
        taken.insert(name)
    }
    return names
}

/// `Servers` property for a server; keywords such as `default` are backticked.
func serverPropertyName(_ server: String) -> String {
    escapedSwiftName(camelCase(server))
}
