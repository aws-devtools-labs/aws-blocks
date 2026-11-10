import Foundation


public nonisolated enum Kind: String, Codable {
    case a_b = "a\"b"
    case c_d = "c;d"
    case x_y = "x`y"
    case new_line = "new\nline"
    case __x_ = "${x}"
    case __z_ = "\\(z)"
    case __unnamed = "*/"
    case _1st = "1st"
    case _sp_ace = " sp ace"
}

public nonisolated struct Sample_Type__x___: Codable {
    public let _unnamed: String?
    public let __x_: String?
    public let __unnamed: String?
    public let _9lives: Bool?
    public let __y_: String?
    public let back_tick: String?
    public let kind: Kind?
    public let new_line: String?
    public let q_uote: String?
    public let run___error__x________id: String
    public let s_ingle: String?
    public let semi_colon: String
    public let with_space: Int

    enum CodingKeys: String, CodingKey {
        case _unnamed = "$"
        case __x_ = "${x}"
        case __unnamed = "*/"
        case _9lives = "9lives"
        case __y_ = "\\(y)"
        case back_tick = "back`tick"
        case kind
        case new_line = "new\nline"
        case q_uote = "q\"uote"
        case run___error__x________id = "run { error(\"x\") } || id"
        case s_ingle = "s'ingle"
        case semi_colon = "semi;colon"
        case with_space = "with space"
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self._unnamed, forKey: ._unnamed)
        try c.encodeIfPresent(self.__x_, forKey: .__x_)
        try c.encodeIfPresent(self.__unnamed, forKey: .__unnamed)
        try c.encodeIfPresent(self._9lives, forKey: ._9lives)
        try c.encodeIfPresent(self.__y_, forKey: .__y_)
        try c.encodeIfPresent(self.back_tick, forKey: .back_tick)
        try c.encodeIfPresent(self.kind, forKey: .kind)
        try c.encodeIfPresent(self.new_line, forKey: .new_line)
        try c.encodeIfPresent(self.q_uote, forKey: .q_uote)
        try c.encode(self.run___error__x________id, forKey: .run___error__x________id)
        try c.encodeIfPresent(self.s_ingle, forKey: .s_ingle)
        try c.encode(self.semi_colon, forKey: .semi_colon)
        try c.encode(self.with_space, forKey: .with_space)
    }

    public init(_unnamed: String? = nil, __x_: String? = nil, __unnamed: String? = nil, _9lives: Bool? = nil, __y_: String? = nil, back_tick: String? = nil, kind: Kind? = nil, new_line: String? = nil, q_uote: String? = nil, run___error__x________id: String, s_ingle: String? = nil, semi_colon: String, with_space: Int) throws {
        self._unnamed = _unnamed
        self.__x_ = __x_
        self.__unnamed = __unnamed
        self._9lives = _9lives
        self.__y_ = __y_
        self.back_tick = back_tick
        self.kind = kind
        self.new_line = new_line
        self.q_uote = q_uote
        guard run___error__x________id.count >= 2 else { throw CodegenError.validation("run { error(\"x\") } || id must be at least 2 characters") }
        self.run___error__x________id = run___error__x________id
        self.s_ingle = s_ingle
        guard semi_colon.count <= 10 else { throw CodegenError.validation("semi;colon must be at most 10 characters") }
        self.semi_colon = semi_colon
        guard with_space >= 1 else { throw CodegenError.validation("with space must be >= 1") }
        self.with_space = with_space
    }
}