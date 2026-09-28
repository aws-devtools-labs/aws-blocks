import 'harness.dart';

void main() async {
  final blocks = createBlocks();
  final prefix = 'kv_${DateTime.now().millisecondsSinceEpoch}';

  group('KVStore: basic round-trip');
  final r = await blocks.api.kvPut(key: '${prefix}_a', value: 'hello');
  check(r.success, 'kvPut returns success');
  final v = await blocks.api.kvGet(key: '${prefix}_a');
  check(v == 'hello', 'kvGet returns stored value (got: $v)');

  group('KVStore: null for missing key');
  final missing = await blocks.api.kvGet(key: '${prefix}_nonexistent');
  check(missing == null, 'missing key returns null');

  group('KVStore: overwrite');
  await blocks.api.kvPut(key: '${prefix}_b', value: 'first');
  await blocks.api.kvPut(key: '${prefix}_b', value: 'second');
  final overwritten = await blocks.api.kvGet(key: '${prefix}_b');
  check(overwritten == 'second', 'overwrite works (got: $overwritten)');

  group('KVStore: empty string value');
  await blocks.api.kvPut(key: '${prefix}_empty', value: '');
  final empty = await blocks.api.kvGet(key: '${prefix}_empty');
  check(empty == '', 'empty string stored and retrieved');

  group('KVStore: unicode');
  await blocks.api.kvPut(key: '${prefix}_uni', value: '日本語 🎉 émojis');
  final uni = await blocks.api.kvGet(key: '${prefix}_uni');
  check(uni == '日本語 🎉 émojis', 'unicode round-trip (got: $uni)');

  group('KVStore: large value');
  final large = 'x' * 10000;
  await blocks.api.kvPut(key: '${prefix}_large', value: large);
  final largeBack = await blocks.api.kvGet(key: '${prefix}_large');
  check(largeBack == large, 'large value (10KB) round-trip');

  group('KVStore: special characters in key');
  await blocks.api.kvPut(key: '${prefix}/slashes/and spaces!@#', value: 'ok');
  final special = await blocks.api.kvGet(
    key: '${prefix}/slashes/and spaces!@#',
  );
  check(special == 'ok', 'special chars in key (got: $special)');

  group('KVStore: delete');
  await blocks.api.kvPut(key: '${prefix}_del', value: 'temp');
  await blocks.api.kvDelete(key: '${prefix}_del');
  final deleted = await blocks.api.kvGet(key: '${prefix}_del');
  check(deleted == null, 'deleted key returns null');

  group('KVStore: parallel writes and reads');
  final futures = List.generate(
    10,
    (i) => blocks.api.kvPut(key: '${prefix}_par_$i', value: 'val_$i'),
  );
  final results = await Future.wait(futures);
  check(results.every((r) => r.success), 'all 10 parallel writes succeeded');
  final reads = await Future.wait(
    List.generate(10, (i) => blocks.api.kvGet(key: '${prefix}_par_$i')),
  );
  for (var i = 0; i < 10; i++) {
    check(reads[i] == 'val_$i', 'parallel read $i correct');
  }

  printResults();
}
