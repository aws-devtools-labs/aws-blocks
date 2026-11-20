// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:blocks_runtime/src/token_store.dart';

/// What a file or directory name may hold. Anything else is replaced.
final _unsafeCharacters = RegExp('[^A-Za-z0-9._-]');

/// Long enough for a reverse-DNS id, short enough for any path limit.
const _maxNameLength = 120;

/// A [TokenStore] that keeps each value in a file of its own, for pure Dart
/// programs on a desktop or server operating system.
///
/// The files live in `~/.blocks/<applicationId>/dart/` (`%USERPROFILE%` on
/// Windows), one per key. [applicationId] is a stable identifier for your
/// program, conventionally reverse-DNS, and is what keeps one program's
/// stored session apart from another's: the home directory is shared by
/// every program you run, so two programs with the same id share one session.
/// Pick a value unique to your program and keep it; changing it later points
/// the program at a different directory, which reads to the user as being
/// signed out. The id is reduced to characters a directory name can hold, and
/// when that changes anything a digest of the id as given is appended, so two
/// ids that reduce to the same name still get separate directories.
///
/// The values are not encrypted. On Linux and macOS the store makes the
/// `<applicationId>` directory owner-only (`rwx------`) before it reads or
/// writes anything, and writes each file owner-only (`rw-------`), which
/// keeps other OS users out; it fails the operation if it cannot. On Windows it cannot set owner-only permissions, so the files
/// keep the access control list they inherit from your user profile: by
/// default that keeps other standard users out, but administrators and the
/// system account can still read them. In either case the files are not
/// protected from other processes running as the same OS user, or from anyone
/// who can read a backup or copy of the directory. If that is not acceptable,
/// keep the session in memory instead.
///
/// Each write goes to a temporary file that is then renamed over the old one,
/// so a process that dies mid-write leaves the previous value in place.
///
/// The class is `final`: implement [TokenStore] for a store of your own.
final class FileTokenStore implements TokenStore {
  /// Creates a store for [applicationId]. [rootDirectory] is where `.blocks`
  /// is created, the user's home directory by default; tests pass a
  /// temporary directory.
  ///
  /// Throws an [ArgumentError] when [applicationId] is blank, and a
  /// [StateError] when [rootDirectory] is null and the home directory is not
  /// set in the environment (`HOME`, or `USERPROFILE` on Windows).
  FileTokenStore({required String applicationId, String? rootDirectory})
    : directoryPath = _join(
        _join(
          _join(rootDirectory ?? _homeDirectory(), '.blocks'),
          _storageName(_requireId(applicationId)),
        ),
        'dart',
      );

  /// The directory this store's files are in.
  final String directoryPath;

  late final Directory _directory = Directory(directoryPath);

  Future<void>? _prepared;

  @override
  Future<String?> get(String key) async {
    await _prepare();
    final file = _fileFor(key);
    try {
      return await file.readAsString();
    } on PathNotFoundException {
      return null;
    }
  }

  @override
  Future<void> set(String key, String value) async {
    await _prepare();
    final file = _fileFor(key);
    final temporary = File(
      '${file.path}.${Random.secure().nextInt(1 << 32).toRadixString(16)}.tmp',
    );
    try {
      // Owner-only before the value goes in, so it is never readable by
      // others even for a moment; the rename keeps the mode.
      await temporary.create(exclusive: true);
      if (!Platform.isWindows) await _chmod('600', temporary.path);
      await temporary.writeAsString(value, flush: true);
      await temporary.rename(file.path);
    } on Object {
      // Any failure, including a ProcessException from chmod, would otherwise
      // leave the randomly named temporary file behind.
      if (temporary.existsSync()) await temporary.delete();
      rethrow;
    }
  }

  @override
  Future<void> delete(String key) async {
    await _prepare();
    try {
      await _fileFor(key).delete();
    } on PathNotFoundException {
      // Already gone.
    }
  }

  File _fileFor(String key) =>
      File(_join(directoryPath, '${_storageName(key)}.value'));

  /// Creates the directory and makes it owner-only once. A failure is not
  /// remembered, so a later operation tries again.
  Future<void> _prepare() async {
    final preparing = _prepared ??= _createOwnerOnly();
    try {
      await preparing;
    } on Object {
      if (identical(_prepared, preparing)) _prepared = null;
      rethrow;
    }
  }

  Future<void> _createOwnerOnly() async {
    await _directory.create(recursive: true);
    if (Platform.isWindows) return;
    // `dart:io` cannot set permissions. The application directory is made
    // owner-only, which also covers this `dart` directory and its files:
    // without search permission on a parent, no other user reaches them.
    final applicationDirectory = _directory.parent.path;
    if (await _isOwnerOnly(applicationDirectory)) return;
    await _chmod('700', applicationDirectory);
  }

  /// Sets [path]'s permissions to [mode] (octal, as `chmod` takes it) and
  /// checks that group and others are left with none. Throws a
  /// [FileSystemException] when it cannot.
  static Future<void> _chmod(String mode, String path) async {
    // An absolute path, so a PATH without chmod (a minimal container) cannot
    // make this run something else or fail with a ProcessException.
    final chmod = _chmodPaths.firstWhere(
      (candidate) => File(candidate).existsSync(),
      orElse: () => throw FileSystemException(
        'Could not make the session storage owner-only: chmod not found at '
        '${_chmodPaths.join(' or ')}',
        path,
      ),
    );
    final result = await Process.run(chmod, [mode, path]);
    if (result.exitCode != 0 || !await _isOwnerOnly(path)) {
      throw FileSystemException(
        'Could not make the session storage owner-only '
        '(${result.stderr.toString().trim()})',
        path,
      );
    }
  }

  static const _chmodPaths = ['/bin/chmod', '/usr/bin/chmod'];

  /// Whether no one but the owner has any permission on [path].
  static Future<bool> _isOwnerOnly(String path) async =>
      (await FileStat.stat(path)).mode & 0x3F == 0;

  static String _requireId(String applicationId) {
    if (applicationId.trim().isEmpty) {
      throw ArgumentError.value(
        applicationId,
        'applicationId',
        'must not be blank',
      );
    }
    return applicationId;
  }

  static String _homeDirectory() {
    final home = Platform.isWindows
        ? Platform.environment['USERPROFILE']
        : Platform.environment['HOME'];
    if (home == null || home.isEmpty) {
      throw StateError(
        'The home directory is not set; pass rootDirectory to FileTokenStore.',
      );
    }
    return home;
  }

  static String _join(String parent, String child) =>
      '$parent${Platform.pathSeparator}$child';

  /// [name] reduced to characters a file name can hold, with a digest of the
  /// original appended when the reduction changed anything. Stripping a
  /// leading dot counts as a change, so `.foo` and `foo` get different names.
  static String _storageName(String name) {
    final original = name.trim();
    // A leading dot would hide the entry, and `.`/`..` would name a parent.
    final trimmed = original.replaceFirst(RegExp(r'^\.+'), '');
    var safe = trimmed.replaceAll(_unsafeCharacters, '_');
    if (safe.length > _maxNameLength) {
      safe = safe.substring(0, _maxNameLength);
    }
    return safe == original && safe.isNotEmpty
        ? safe
        : '$safe-${_digest(name)}';
  }

  /// FNV-1a, for a short stable suffix. Not a security property, only
  /// distinctness.
  static String _digest(String value) {
    var hash = BigInt.parse('cbf29ce484222325', radix: 16);
    final prime = BigInt.parse('100000001b3', radix: 16);
    final mask = (BigInt.one << 64) - BigInt.one;
    for (final byte in utf8.encode(value)) {
      hash = ((hash ^ BigInt.from(byte)) * prime) & mask;
    }
    return hash.toRadixString(16).padLeft(16, '0');
  }
}
