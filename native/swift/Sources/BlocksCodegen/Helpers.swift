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

/// Names a type nested inside a component schema's struct must not take: within that struct
/// they would shadow a type the generated code (or a sibling field) refers to by its bare name.
let nestedShadowingTypeNames: Set<String> = [
    "String", "Bool", "Int", "Double", "Void", "Self", "Protocol",
    "UUID", "Date", "URL", "JSONValue",
    "Codable", "Encoder", "Decoder", "CodingKey", "CodingKeys", "DecodingError", "EncodingError",
    "DynamicKey", "OuterCodingKeys", "EmptyKey", "CodegenError",
    "RealtimeChannel", "FileDownloadHandle", "FileUploadHandle", "OIDCClient"
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
/// A value that can't start a type name (a number: `code: 1` → `Code1`, `1.5` → `Code1_5`) is prefixed the same way,
/// and so is one that names a keyword type (`kind: "self"` → `KindSelf`; a type can't be named `Self` or `Any`).
func variantNameFromDiscriminator(fieldName: String, value: String) -> String {
    if value == "true" || value == "false" {
        return specTypeName(fieldName) + pascalCase(value)
    }
    let name = pascalCase(value)
    if keywordTypeNames.contains(name) {
        return specTypeName(fieldName) + name
    }
    if let first = name.first, first.isLetter || first == "_", isValidSwiftIdentifier(name) {
        return name
    }
    let spelled = String(value.map { $0.isLetter || $0.isNumber ? $0 : "_" })
    return specTypeName(fieldName) + spelled
}

/// Keywords a type can't be named, though they're identifiers in form.
let keywordTypeNames: Set<String> = ["Self", "Any"]

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

/// The Swift property name of each field of a record, by wire name (escaped): each spec name, sanitized when it
/// isn't an identifier and unique among its siblings (see `swiftIdentifiers`).
func swiftPropertyNames(_ fields: [ResolvedField]) -> [String: String] {
    let names = swiftIdentifiers(for: fields.map(\.name), candidate: swiftIdentifierCandidate)
    return Dictionary(zip(fields.map(\.name), names), uniquingKeysWith: { first, _ in first })
}

/// The parameter name a generated memberwise init uses for `field`. It's the property name, except for a
/// property named `self`: a parameter named `self` would shadow the instance, so the init takes it as
/// `` `self` self_: T `` (label unchanged) and assigns `` self.`self` = self_ ``.
func initArgumentName(_ field: ResolvedField, in fields: [ResolvedField]) -> String {
    let names = swiftPropertyNames(fields)
    let safe = names[field.name] ?? escapedSwiftName(field.name)
    guard safe == "`self`" else { return safe }
    let taken = Set(names.values)
    var name = "self_"
    while taken.contains(name) {
        name += "_"
    }
    return name
}

// MARK: - Spec strings and names in generated code

/// The contents of a Swift string literal spelling `text` exactly: `\`, `"`, line breaks, tabs and other
/// control characters are escaped, so a spec string spliced into a literal (a wire key, a method name, a server
/// URL, a validation message) neither breaks the literal nor interpolates. Text without them is unchanged.
func swiftStringContent(_ text: String) -> String {
    var out = ""
    for scalar in text.unicodeScalars {
        switch scalar {
        case "\\": out += "\\\\"
        case "\"": out += "\\\""
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        case "\0": out += "\\0"
        default:
            if scalar.value < 0x20 || scalar.value == 0x7f {
                out += "\\u{\(String(scalar.value, radix: 16))}"
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
    }
    return out
}

/// A type name for a spec name (a property, parameter or operation): its PascalCase, sanitized when that isn't
/// an identifier (`back\slash` → `Back_Slash`). A name that is one is unchanged.
func specTypeName(_ name: String) -> String {
    let pascal = pascalCase(name)
    return isValidSwiftIdentifier(pascal) ? pascal : pascalCase(sanitizedSwiftName(pascal))
}

/// The names taken in one Swift scope. `claim` takes a name, or the first of `name_2`, `name_3`, … that's free.
struct SwiftNameScope {
    private(set) var taken: Set<String>

    init(taken: Set<String> = []) {
        self.taken = taken
    }

    func contains(_ name: String) -> Bool { taken.contains(name) }

    /// `name` (unescaped), or the first `name_<n>` not taken; claimed. Spell it with `escapedSwiftName`.
    mutating func claim(_ name: String) -> String {
        var allocated = name
        var suffix = 2
        while taken.contains(allocated) {
            allocated = "\(name)_\(suffix)"
            suffix += 1
        }
        taken.insert(allocated)
        return allocated
    }
}

/// The Swift identifiers (escaped) for sibling spec names in one scope, in order. `candidate` is the identifier a
/// name would take (by default the name, sanitized when it isn't an identifier). Names whose candidate is the spec
/// name itself claim it first; every other one takes its candidate, or `_2`, `_3`, … when a sibling has it
/// (`a_b` keeps `a_b`, `a.b` takes `a_b_2`). `taken` are names the scope already declares. With no collision
/// each name is its candidate, escaped, as before.
func swiftIdentifiers(
    for specNames: [String], taken: Set<String> = [], candidate: (String) -> String = { name in
        isValidSwiftIdentifier(name) ? name : sanitizedSwiftName(name)
    }
) -> [String] {
    var scope = SwiftNameScope(taken: taken)
    var allocated: [String?] = Array(repeating: nil, count: specNames.count)
    let candidates = specNames.map(candidate)
    for (index, name) in specNames.enumerated() where candidates[index] == name && !scope.contains(name) {
        allocated[index] = scope.claim(name)
    }
    for index in specNames.indices where allocated[index] == nil {
        allocated[index] = scope.claim(candidates[index])
    }
    return allocated.map { escapedSwiftName($0 ?? "") }
}

/// `name` without the backticks `escapedSwiftName` puts around a keyword.
func unescapedSwiftName(_ name: String) -> String {
    name.hasPrefix("`") && name.hasSuffix("`") && name.count > 2 ? String(name.dropFirst().dropLast()) : name
}
