// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

@TestOn('vm')
library;

import 'dart:io';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:test/test.dart';

void main() {
  late Directory root;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('file_token_store_test');
  });

  tearDown(() => root.delete(recursive: true));

  FileTokenStore store(String applicationId) =>
      FileTokenStore(applicationId: applicationId, rootDirectory: root.path);

  test('round-trips, overwrites and deletes values', () async {
    final s = store('com.example.app');
    expect(await s.get('_session_cookies'), isNull);
    await s.set('_session_cookies', '[1]');
    await s.set('_session_cookies', '[2]');
    expect(await s.get('_session_cookies'), '[2]');
    await s.delete('_session_cookies');
    await s.delete('_session_cookies');
    expect(await s.get('_session_cookies'), isNull);
  });

  test('a new instance reads what an earlier one wrote', () async {
    await store('com.example.app').set('k', 'v');
    expect(await store('com.example.app').get('k'), 'v');
  });

  test('keeps applications apart', () async {
    await store('com.example.one').set('k', 'one');
    await store('com.example.two').set('k', 'two');
    expect(await store('com.example.one').get('k'), 'one');
    expect(await store('com.example.two').get('k'), 'two');
  });

  test('lives under .blocks/<applicationId>/dart', () {
    final s = store('com.example.app');
    expect(
      s.directoryPath,
      [
        root.path,
        '.blocks',
        'com.example.app',
        'dart',
      ].join(Platform.pathSeparator),
    );
  });

  test('ids that reduce to the same name get separate directories', () {
    final a = Directory(store('My/App').directoryPath).parent;
    final b = Directory(store('My App').directoryPath).parent;
    expect(a.path, isNot(b.path));
    expect(a.path.split(Platform.pathSeparator).last, startsWith('My_App-'));
    // `..` cannot climb out of `.blocks`.
    expect(
      Directory(store('..').directoryPath).parent.parent.path,
      endsWith('${Platform.pathSeparator}.blocks'),
    );
  });

  test('a leading dot is not stripped into a collision', () async {
    String directory(String id) => Directory(
      store(id).directoryPath,
    ).parent.path.split(Platform.pathSeparator).last;
    expect(directory('acme.cli'), 'acme.cli');
    expect(directory(' acme.cli '), 'acme.cli');
    expect(directory('.acme.cli'), startsWith('acme.cli-'));

    final s = store('com.example.app');
    await s.set('.foo', 'dotted');
    await s.set('foo', 'plain');
    expect(await s.get('.foo'), 'dotted');
    expect(await s.get('foo'), 'plain');
    expect(
      File('${s.directoryPath}${Platform.pathSeparator}foo.value').existsSync(),
      isTrue,
    );
  });

  test('rejects a blank application id', () {
    expect(() => store('  '), throwsArgumentError);
  });

  test('makes the application directory owner-only', () async {
    await store('com.example.app').set('k', 'v');
    final mode = (await FileStat.stat(
      [root.path, '.blocks', 'com.example.app'].join(Platform.pathSeparator),
    )).mode;
    expect(mode & 0x1FF, 0x1C0, reason: 'rwx------');
  }, testOn: '!windows');

  test('does not need chmod on PATH', () async {
    final script = File('${root.path}${Platform.pathSeparator}probe.dart')
      ..writeAsStringSync('''
import 'package:blocks_runtime/blocks_runtime.dart';

Future<void> main(List<String> args) async {
  await FileTokenStore(applicationId: 'com.example.app', rootDirectory: args.first).set('k', 'v');
  print('stored');
}
''');
    final packages = File(
      '.dart_tool${Platform.pathSeparator}package_config.json',
    ).absolute.path;
    final result = await Process.run(
      Platform.resolvedExecutable,
      ['--packages=$packages', script.path, root.path],
      environment: {'PATH': '/nonexistent'},
      includeParentEnvironment: false,
    );
    expect(result.stdout, contains('stored'), reason: '${result.stderr}');
    final mode = (await FileStat.stat(
      [root.path, '.blocks', 'com.example.app'].join(Platform.pathSeparator),
    )).mode;
    expect(mode & 0x1FF, 0x1C0);
  }, testOn: '!windows');

  test('writes each value owner-only', () async {
    final s = store('com.example.app');
    await s.set('k', 'v');
    await s.set('k', 'w');
    final mode = (await FileStat.stat(
      [s.directoryPath, 'k.value'].join(Platform.pathSeparator),
    )).mode;
    expect(mode & 0x1FF, 0x180, reason: 'rw-------');
  }, testOn: '!windows');

  test('leaves no temporary files behind', () async {
    final s = store('com.example.app');
    await s.set('k', 'v');
    await s.set('k', 'w');
    expect(
      Directory(s.directoryPath).listSync().map(
        (FileSystemEntity e) => e.path.split(Platform.pathSeparator).last,
      ),
      ['k.value'],
    );
  });

  test('backs a PersistentSessionStore across restarts', () async {
    final uri = Uri.parse('https://api.example.com/cdk-blocks/api');
    final first = PersistentSessionStore(store: store('com.example.app'))
      ..setCookies('blocks_session=s1; Path=/; HttpOnly', requestUri: uri);
    // File I/O is not a microtask; wait for the write.
    for (
      var i = 0;
      i < 100 && await store('com.example.app').get('_session_cookies') == null;
      i++
    ) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    expect(first.cookies, {'blocks_session': 's1'});

    final next = PersistentSessionStore(store: store('com.example.app'));
    await next.load();
    expect(await next.cookieHeaderFor(uri), 'blocks_session=s1');
  });
}
