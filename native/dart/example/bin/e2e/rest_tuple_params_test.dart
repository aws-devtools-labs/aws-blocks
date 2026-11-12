import 'harness.dart';

/// Tuples on the wire, against the real server, which calls a method with its
/// params spread (`method(...params)`).
///
/// A rest parameter typed as a tuple (`...args: [label: string, count?:
/// number]`, or `...args: Parameters<typeof describeKey>`) takes one
/// positional param per element. The spec used to describe it as one param
/// holding the tuple, so the client sent `[["x", 2]]` and the method's `args`
/// was `[["x", 2]]`.
///
/// A one-element tuple is a one-element list (`["abc"]`), and an optional
/// element left out of a shorter array (`["abc"]` for `[string, number?]`)
/// decodes as null. The client used to send the one element bare and throw a
/// `RangeError` on the short array.
void main() async {
  final blocks = createBlocks();

  group('RPC wire: a rest tuple parameter is one positional param per element');
  final both = await blocks.api.echoRestArgs(label: 'x', count: 2);
  check(both.argCount == 2, 'args has 2 elements (got: ${both.argCount})');
  check(both.label == 'x', 'label is the first (got: ${both.label})');
  check(both.count == 2, 'count is the second (got: ${both.count})');
  final labelOnly = await blocks.api.echoRestArgs(label: 'y');
  check(
    labelOnly.argCount == 1 && labelOnly.count == null,
    'a left-out optional element is left off '
    '(got: ${labelOnly.argCount}, ${labelOnly.count})',
  );

  group('RPC wire: a rest parameter typed by Parameters<typeof f>');
  final forwarded = await blocks.api.echoForwardedArgs(
    key: 'k',
    options: ApiEchoForwardedArgsOptions(tag: 't'),
  );
  check(
    forwarded.argCount == 2 && forwarded.key == 'k' && forwarded.tag == 't',
    'key and options arrive in their slots '
    '(got: ${forwarded.argCount}, ${forwarded.key}, ${forwarded.tag})',
  );

  group('RPC wire: one-element and short tuples');
  final tuples = await blocks.api.echoTuples(one: ['abc']);
  check(
    tuples.one.length == 1 && tuples.one.first == 3,
    'a one-element tuple is sent as ["abc"] and decodes from [3] '
    '(got: ${tuples.one})',
  );
  check(
    tuples.short.$1 == 'abc' && tuples.short.$2 == null,
    'an optional element missing from ["abc"] is null (got: ${tuples.short})',
  );
  check(
    tuples.pair.$1 == 'abc' && tuples.pair.$2 == 3,
    'a pair decodes from ["abc", 3] (got: ${tuples.pair})',
  );

  printResults();
}
