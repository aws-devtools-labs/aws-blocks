import Foundation
import BlocksRuntime


public nonisolated enum Kind: String, Codable {
    case cost_ = "cost$"
    case a_b = "a$b"
    case x__y = "x$$y"
    case b_c = "b-$c"
    case d__e = "d_$e"
}

public nonisolated struct Widget: Codable {
    public let code: String
    public let count: Int?
    public let flag: Bool?
    public let id: String
    public let kind: Kind
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

    public init(code: String, count: Int? = 7, flag: Bool? = true, id: String, kind: Kind, limit: Int? = 99999999999, note_: String? = "a/b é $x ${y} \"q\" 'q' \\ \\(z) */ end", ratio: Double? = 1.5, scale: Double? = 3) throws {
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