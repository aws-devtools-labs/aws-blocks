// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';

import 'package:http/http.dart' as http;

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
/// `{first: 'a', last: 'c'}`, which the server read as `middle = 'c'` (see
/// also Kotlin's `RpcWireE2ETest`).
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

  // The server answers a method that returns nothing with `"result": null`;
  // the Kotlin and Swift clients threw on a response with no `result` field.
  // The client reads a missing key as null too, so check the raw response.
  group('RPC wire: a void method answers "result": null');
  await blocks.api.voidResult();
  final voidResponse = await http.post(
    Uri.parse(blocksUrl()),
    headers: {'Content-Type': 'application/json'},
    body: jsonEncode({
      'jsonrpc': '2.0',
      'method': 'api.voidResult',
      'params': <dynamic>[],
      'id': 1,
    }),
  );
  final voidBody = jsonDecode(voidResponse.body) as Map<String, dynamic>;
  check(
    voidBody.containsKey('result') && voidBody['result'] == null,
    'the response carries "result": null (got: ${voidResponse.body})',
  );

  // Why the client can't send by name: the server reads an object's values
  // in order, so a left-out key moves the later values up. If the
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

  // The server sends no name for a missing method, so the client fills in
  // the reserved code's own name rather than leaving an anonymous 500.
  group('RPC wire: errors cross the wire by name');
  try {
    await raw.call('api.noSuchMethod', []);
    check(false, 'a missing method throws');
  } on ApiException catch (e) {
    check(
      e.status == 500 && isBlocksError(e, 'MethodNotFound'),
      'a missing method is a 500 named MethodNotFound '
      '(got: ${e.status} ${e.name})',
    );
  }

  group('RPC wire: a call after close() fails without a request');
  raw.close();
  try {
    await raw.call('api.echoArgs', ['a']);
    check(false, 'a call after close() throws');
  } on ClientClosedException {
    check(true, 'a call after close() throws ClientClosedException');
  }

  printResults();
}
