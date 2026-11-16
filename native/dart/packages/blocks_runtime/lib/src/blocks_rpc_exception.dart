import 'blocks_exception.dart';

/// Typed exception for JSON-RPC error responses from a Blocks backend.
class BlocksRpcException implements BlocksException {
  final int code;
  @override
  final String message;
  final dynamic data;

  BlocksRpcException({required this.code, required this.message, this.data});

  /// The server's error name (`error.data.name`, e.g.
  /// `NotAuthenticatedException`), or null when the server sent none.
  ///
  /// Errors cross the wire by name, so match on this rather than on [code] or
  /// [message]. See [isBlocksError].
  String? get name => switch (data) {
    {'name': final String name} => name,
    _ => null,
  };

  @override
  String toString() => 'BlocksRpcException($code): $message';
}

/// Whether [error] is a [BlocksRpcException] whose [BlocksRpcException.name]
/// is [name].
///
/// Use it to match a server error by name, the way the TypeScript client's
/// `isBlocksError(e, SomeErrors.Foo)` does. Here `signUp` stands for a
/// method of your own backend:
///
/// ```dart
/// try {
///   await blocks.api.signUp(username: username, password: password);
/// } catch (e) {
///   if (!isBlocksError(e, 'UsernameExistsException')) rethrow;
///   // The user already exists: offer to sign in instead.
/// }
/// ```
///
/// To read the exception's fields as well, catch the type or use a pattern:
/// `on BlocksRpcException catch (e)`, or
/// `case BlocksRpcException(name: 'UsernameExistsException')`.
bool isBlocksError(Object? error, String name) =>
    error is BlocksRpcException && error.name == name;
