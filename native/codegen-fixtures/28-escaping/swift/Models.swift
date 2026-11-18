import Foundation
import BlocksRuntime


public nonisolated enum WidgetKind: RawRepresentable, Codable, Hashable, Sendable {
    case cost_
    case a_b
    case x__y
    case b_c
    case d__e
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "cost$": self = .cost_
        case "a$b": self = .a_b
        case "x$$y": self = .x__y
        case "b-$c": self = .b_c
        case "d_$e": self = .d__e
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .cost_: return "cost$"
        case .a_b: return "a$b"
        case .x__y: return "x$$y"
        case .b_c: return "b-$c"
        case .d__e: return "d_$e"
        case .unknown(let value): return value
        }
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.cost_, .cost_): return true
        case (.a_b, .a_b): return true
        case (.x__y, .x__y): return true
        case (.b_c, .b_c): return true
        case (.d__e, .d__e): return true
        case let (.unknown(lhs), .unknown(rhs)): return lhs == rhs
        default: return false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self {
        case .cost_: hasher.combine(0)
        case .a_b: hasher.combine(1)
        case .x__y: hasher.combine(2)
        case .b_c: hasher.combine(3)
        case .d__e: hasher.combine(4)
        case .unknown(let value):
            hasher.combine(5)
            hasher.combine(value)
        }
    }
}

public nonisolated struct Widget: Codable, Sendable {
    public let code: String
    public let count: Int?
    public let flag: Bool?
    public let id: String
    public let kind: WidgetKind
    public let limit: Int?
    public let note_: String?
    public let ratio: Double?
    public let scale: Double?

    enum CodingKeys: String, CodingKey {
        case code
        case count
        case flag
        case id
        case kind
        case limit
        case note_ = "note$"
        case ratio
        case scale
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.code, forKey: .code)
        try c.encodeIfPresent(self.count, forKey: .count)
        try c.encodeIfPresent(self.flag, forKey: .flag)
        try c.encode(self.id, forKey: .id)
        try c.encode(self.kind, forKey: .kind)
        try c.encodeIfPresent(self.limit, forKey: .limit)
        try c.encodeIfPresent(self.note_, forKey: .note_)
        try c.encodeIfPresent(self.ratio, forKey: .ratio)
        try c.encodeIfPresent(self.scale, forKey: .scale)
    }

    public init(code: String, count: Int? = 7, flag: Bool? = true, id: String, kind: WidgetKind, limit: Int? = 99999999999, note_: String? = "a/b é $x ${y} \"q\" 'q' \\ \\(z) */ end", ratio: Double? = 1.5, scale: Double? = 3) throws {
        guard code.range(of: "^a'b\"c\\$d[${x}]+$", options: .regularExpression) != nil else { throw CodegenError.validation("code must match pattern ^a'b\"c\\$d[${x}]+$") }
        self.code = code
        self.count = count
        self.flag = flag
        self.id = id
        self.kind = kind
        self.limit = limit
        self.note_ = note_
        self.ratio = ratio
        self.scale = scale
    }
}