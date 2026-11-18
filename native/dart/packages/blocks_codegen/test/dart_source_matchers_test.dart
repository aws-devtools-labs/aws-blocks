import 'package:test/test.dart' hide contains;

import 'dart_source_matchers.dart';

void main() {
  test('accepts formatter whitespace and optional call commas', () {
    expect(
      "call(\n  value: 'wire value',\n);",
      contains("call(value: 'wire value')"),
    );
  });

  test('preserves semantic record commas', () {
    expect('(value,)', isNot(contains('(value)')));
    expect('(value)', isNot(contains('(value,)')));
    expect('return(value,);', isNot(contains('return(value);')));
    expect('return (value,);', isNot(contains('return (value);')));
    expect('required (int,) field', isNot(contains('required (int) field')));
    expect('var(value,) = record', isNot(contains('var(value) = record')));
  });

  test('rejects different tokens and reordered arguments', () {
    expect('call(first, second)', isNot(contains('call(first, third)')));
    expect('call(first, second)', isNot(contains('call(second, first)')));
  });

  test('preserves string contents and token boundaries', () {
    expect("call('wire  value')", isNot(contains("call('wire value')")));
    expect('intValue', isNot(contains('int Value')));
  });

  test('keeps whitespace-only checks exact', () {
    expect(r'escaped\nnewline', isNot(contains('\n')));
    expect('physical\nnewline', contains('\n'));
  });
}
