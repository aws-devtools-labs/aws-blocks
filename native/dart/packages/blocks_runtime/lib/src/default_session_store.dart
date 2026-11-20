// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'package:blocks_runtime/src/session_store.dart';

SessionStore Function()? _create;
SessionStore? _shared;

/// Makes [create] the source of the session store that every `BlocksClient`
/// and `OidcClient` uses when it is given none, including the generated
/// `Blocks` built without a `sessionStore:`.
///
/// [create] runs once, on the first client that needs it, and that one store
/// is then shared by every such client in the isolate, so they see the same
/// cookies and do not overwrite each other's in storage.
///
/// Register before creating any client. Once a client has received the
/// shared store, registering a different [create] throws a [StateError]:
/// a second store over the same storage would overwrite the first one's
/// cookies. Registering the same [create] again (the same function, as a
/// top-level or static function always is) does nothing, at any time.
///
/// Passing `null` goes back to the built-in default, a new
/// [InMemorySessionStore] for each client, and is allowed at any time; tests
/// call it in `tearDown`. Clients created before keep the store they got.
///
/// `blocks_runtime_flutter` registers a store backed by the platform's secure
/// storage automatically, so a Flutter app does not call this. A pure Dart
/// program (a command-line tool, for instance) has no per-application storage
/// to default to, and registers one itself to keep its session across
/// restarts:
///
/// ```dart
/// registerDefaultSessionStore(
///   () => PersistentSessionStore(
///     store: FileTokenStore(applicationId: 'com.example.notes_cli'),
///   ),
/// );
/// ```
void registerDefaultSessionStore(SessionStore Function()? create) {
  if (create != null && identical(create, _create)) return;
  if (create != null && _shared != null) {
    throw StateError(
      'registerDefaultSessionStore was called after a client already got the '
      'default session store. Register the default before creating any '
      'BlocksClient, OidcClient or Blocks; a second store over the same '
      'storage would overwrite the first one\'s cookies.',
    );
  }
  _create = create;
  _shared = null;
}

/// The session store a client uses when it is given none: the store
/// [registerDefaultSessionStore] registered, shared by every client in the
/// isolate, or, when nothing is registered, a new [InMemorySessionStore].
///
/// Used by `BlocksClient` and `OidcClient`; not exported.
SessionStore defaultSessionStore() {
  final create = _create;
  if (create == null) return InMemorySessionStore();
  return _shared ??= create();
}
