import 'harness.dart';

/// The JSON-RPC wire contract the generated client relies on, against the
/// real server (`parseRpcRequest` in `packages/core`).
///
/// Params are positional: the server calls the method with `params` as its
/// argument list, and reads a by-name object by its values, in order. A
/// generated call that leaves out an optional argument before a set one sends
/// `null` in its slot, as the TypeScript client does, so
/// `echoArgs(first: 'a', last: 'c')` reaches the server as
/// `echoArgs('a', null, 'c')`. The base generator sent the by-name map
/// `{first: 'a', last: 'c'}`, which the server read as `middle = 'c'` (FX48;
/// Kotlin's `RpcWireE2ETest`, FX45).
void main() async {
  final blocks = createBlocks();

  group('RPC wire: a left-out middle optional keeps the later one in its slot');
  final skipped = await blocks.api.echoArgs(first: 'a', last: 'c');
  check(skipped.first == 'a', 'first arrives (got: ${skipped.first})');
  check(
    skipped.middle == null,
    'left-out middle arrives as null (got: ${skipped.middle})',
  );
  check(skipped.last == 'c', 'last stays in its slot (got: ${skipped.last})');

  group('RPC wire: every argument set arrives in order');
  final all = await blocks.api.echoArgs(first: 'a', middle: 'b', last: 'c');
  check(all.first == 'a', 'first (got: ${all.first})');
  check(all.middle == 'b', 'middle (got: ${all.middle})');
  check(all.last == 'c', 'last (got: ${all.last})');

  group('RPC wire: trailing unset arguments are left off');
  final onlyFirst = await blocks.api.echoArgs(first: 'a');
  check(
    onlyFirst.middle == null && onlyFirst.last == null,
    'only first: middle and last are null '
    '(got: ${onlyFirst.middle}, ${onlyFirst.last})',
  );
  final firstTwo = await blocks.api.echoArgs(first: 'a', middle: 'b');
  check(firstTwo.middle == 'b', 'first two: middle (got: ${firstTwo.middle})');
  check(
    firstTwo.last == null,
    'first two: last is null (got: ${firstTwo.last})',
  );

  // Why the client can't send by name: the server reads an object's values
  // in order, so a left-out key moves the later values up (L64). If the
  // server starts rejecting or name-mapping object params, update this group.
  group('RPC wire: the server reads by-name params by position');
  final raw = BlocksClient(baseUrl: blocksUrl());
  final byName =
      await raw.call('api.echoArgs', {'first': 'a', 'last': 'c'})
          as Map<String, dynamic>;
  check(
    byName['middle'] == 'c' && byName['last'] == null,
    'a by-name map without `middle` shifts `last` into it '
    '(got: middle=${byName['middle']} last=${byName['last']})',
  );
  final positional =
      await raw.call('api.echoArgs', ['a', null, 'c']) as Map<String, dynamic>;
  check(
    positional['middle'] == null && positional['last'] == 'c',
    'a positional array with a null slot keeps `last` '
    '(got: middle=${positional['middle']} last=${positional['last']})',
  );
  raw.close();

  printResults();
}
