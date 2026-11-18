import 'package:test/test.dart' as test;

/// Matches exact values, or Dart source strings that differ only in whitespace
/// and context-proven optional trailing commas.
test.Matcher contains(Object? expected) => _DartSourceContains(expected);

final class _DartSourceContains extends test.Matcher {
  _DartSourceContains(this.expected) : _exact = test.contains(expected);

  final Object? expected;
  final test.Matcher _exact;

  @override
  test.Description describe(test.Description description) =>
      _exact.describe(description);

  @override
  bool matches(Object? item, Map<Object?, Object?> matchState) {
    if (_exact.matches(item, matchState)) return true;
    if (item is! String || expected is! String) return false;
    final source = item;
    final expectedSource = expected! as String;
    final normalizedExpected = _normalizeDart(expectedSource);
    if (normalizedExpected.isEmpty) return false;
    if (_normalizeDart(source).contains(normalizedExpected)) return true;
    return _normalizeDart(
      source,
      removeOptionalCommas: true,
    ).contains(_normalizeDart(expectedSource, removeOptionalCommas: true));
  }
}

String _normalizeDart(String source, {bool removeOptionalCommas = false}) {
  final output = StringBuffer();
  final delimiters = <({bool callLike, int opener})>[];
  int? lastCodeUnit;
  void writeCodeUnit(int codeUnit) {
    output.writeCharCode(codeUnit);
    lastCodeUnit = codeUnit;
  }

  var index = 0;
  while (index < source.length) {
    final codeUnit = source.codeUnitAt(index);
    if (removeOptionalCommas &&
        codeUnit == 0x2c &&
        _isOptionalTrailingComma(source, index, delimiters)) {
      index++;
      continue;
    }
    if (_isWhitespace(codeUnit)) {
      final previous = lastCodeUnit;
      while (index < source.length && _isWhitespace(source.codeUnitAt(index))) {
        index++;
      }
      if (previous != null &&
          index < source.length &&
          _needsSeparator(previous, source.codeUnitAt(index))) {
        writeCodeUnit(0x20);
      }
      continue;
    }

    if (codeUnit == 0x2f && index + 1 < source.length) {
      final next = source.codeUnitAt(index + 1);
      if (next == 0x2f) {
        while (index < source.length) {
          final commentCodeUnit = source.codeUnitAt(index++);
          writeCodeUnit(commentCodeUnit);
          if (commentCodeUnit == 0x0a) break;
        }
        continue;
      }
      if (next == 0x2a) {
        var depth = 0;
        while (index < source.length) {
          final commentCodeUnit = source.codeUnitAt(index);
          final following = index + 1 < source.length
              ? source.codeUnitAt(index + 1)
              : null;
          if (commentCodeUnit == 0x2f && following == 0x2a) depth++;
          if (commentCodeUnit == 0x2a && following == 0x2f) depth--;
          writeCodeUnit(commentCodeUnit);
          index++;
          if (depth == 0) {
            writeCodeUnit(source.codeUnitAt(index));
            index++;
            break;
          }
        }
        continue;
      }
    }

    final raw =
        (codeUnit == 0x72 || codeUnit == 0x52) &&
        index + 1 < source.length &&
        _isQuote(source.codeUnitAt(index + 1));
    if (_isQuote(codeUnit) || raw) {
      if (raw) {
        writeCodeUnit(codeUnit);
        index++;
      }
      final quote = source.codeUnitAt(index);
      final triple =
          index + 2 < source.length &&
          source.codeUnitAt(index + 1) == quote &&
          source.codeUnitAt(index + 2) == quote;
      final quoteLength = triple ? 3 : 1;
      for (var count = 0; count < quoteLength; count++) {
        writeCodeUnit(source.codeUnitAt(index++));
      }
      while (index < source.length) {
        final stringCodeUnit = source.codeUnitAt(index);
        if (!raw && stringCodeUnit == 0x5c && index + 1 < source.length) {
          writeCodeUnit(stringCodeUnit);
          writeCodeUnit(source.codeUnitAt(index + 1));
          index += 2;
          continue;
        }
        if (stringCodeUnit == quote &&
            (!triple ||
                (index + 2 < source.length &&
                    source.codeUnitAt(index + 1) == quote &&
                    source.codeUnitAt(index + 2) == quote))) {
          for (var count = 0; count < quoteLength; count++) {
            writeCodeUnit(source.codeUnitAt(index++));
          }
          break;
        }
        writeCodeUnit(stringCodeUnit);
        index++;
      }
      continue;
    }

    if (_isOpeningDelimiter(codeUnit)) {
      delimiters.add((
        callLike: codeUnit == 0x28 && _isCallLikeParenthesis(source, index),
        opener: codeUnit,
      ));
    } else if (_isClosingDelimiter(codeUnit) && delimiters.isNotEmpty) {
      delimiters.removeLast();
    }
    writeCodeUnit(codeUnit);
    index++;
  }
  return output.toString();
}

bool _isOptionalTrailingComma(
  String source,
  int commaIndex,
  List<({bool callLike, int opener})> delimiters,
) {
  if (delimiters.isEmpty) return false;
  var index = commaIndex + 1;
  while (index < source.length && _isWhitespace(source.codeUnitAt(index))) {
    index++;
  }
  if (index == source.length) return false;

  final delimiter = delimiters.last;
  final closer = source.codeUnitAt(index);
  if (delimiter.opener == 0x5b && closer == 0x5d) return true;
  if (delimiter.opener == 0x7b && closer == 0x7d) return true;
  if (delimiter.opener != 0x28 || closer != 0x29) return false;

  if (delimiter.callLike) return true;

  index++;
  while (index < source.length && _isWhitespace(source.codeUnitAt(index))) {
    index++;
  }
  return index < source.length &&
      (source.codeUnitAt(index) == 0x7b || source.startsWith('=>', index));
}

bool _isOpeningDelimiter(int codeUnit) =>
    codeUnit == 0x28 || codeUnit == 0x5b || codeUnit == 0x7b;

bool _isClosingDelimiter(int codeUnit) =>
    codeUnit == 0x29 || codeUnit == 0x5d || codeUnit == 0x7d;

bool _isCallLikeParenthesis(String source, int openerIndex) {
  var index = openerIndex - 1;
  while (index >= 0 && _isWhitespace(source.codeUnitAt(index))) {
    index--;
  }
  if (index < 0) return false;

  final previous = source.codeUnitAt(index);
  if (previous == 0x29 || previous == 0x5d || previous == 0x3e) return true;
  if (!_isIdentifierPart(previous)) return false;

  final end = index + 1;
  while (index >= 0 && _isIdentifierPart(source.codeUnitAt(index))) {
    index--;
  }
  final identifier = source.substring(index + 1, end);
  return !const {
    'abstract',
    'as',
    'assert',
    'async',
    'augment',
    'await',
    'base',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'covariant',
    'default',
    'deferred',
    'do',
    'dynamic',
    'else',
    'enum',
    'export',
    'extends',
    'extension',
    'external',
    'factory',
    'false',
    'final',
    'finally',
    'for',
    'get',
    'hide',
    'if',
    'implements',
    'import',
    'in',
    'interface',
    'is',
    'late',
    'library',
    'mixin',
    'new',
    'null',
    'of',
    'on',
    'operator',
    'part',
    'required',
    'rethrow',
    'return',
    'sealed',
    'set',
    'show',
    'static',
    'switch',
    'sync',
    'throw',
    'true',
    'try',
    'typedef',
    'var',
    'void',
    'when',
    'while',
    'with',
    'yield',
  }.contains(identifier);
}

bool _isWhitespace(int codeUnit) =>
    codeUnit == 0x20 ||
    codeUnit == 0x09 ||
    codeUnit == 0x0a ||
    codeUnit == 0x0d ||
    codeUnit == 0x0b ||
    codeUnit == 0x0c;

bool _isQuote(int codeUnit) => codeUnit == 0x22 || codeUnit == 0x27;

bool _isIdentifierPart(int codeUnit) =>
    codeUnit == 0x24 ||
    codeUnit == 0x5f ||
    (codeUnit >= 0x30 && codeUnit <= 0x39) ||
    (codeUnit >= 0x41 && codeUnit <= 0x5a) ||
    (codeUnit >= 0x61 && codeUnit <= 0x7a);

bool _isOperator(int codeUnit) => const {
  0x21,
  0x25,
  0x26,
  0x2a,
  0x2b,
  0x2d,
  0x2f,
  0x3c,
  0x3d,
  0x3e,
  0x3f,
  0x5e,
  0x7c,
  0x7e,
}.contains(codeUnit);

bool _needsSeparator(int before, int after) =>
    (_isIdentifierPart(before) && _isIdentifierPart(after)) ||
    (_isOperator(before) && _isOperator(after)) ||
    (_isQuote(before) && _isQuote(after));
