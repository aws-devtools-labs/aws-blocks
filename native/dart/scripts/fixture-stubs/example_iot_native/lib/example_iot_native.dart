/// Compile-only stub of codegen fixture 27's declared `example-iot-native`
/// package: the `blocks-transferable-v1` factories its bindings name.
library;

/// Binding `example-iot/device-handle`, generic arity 0.
class DeviceHandle {
  DeviceHandle._(this.descriptor);

  /// The validated `{"__blocks": …}` descriptor.
  final Map<String, dynamic> descriptor;

  factory DeviceHandle.fromBlocksDescriptor(Map<String, dynamic> descriptor) =>
      DeviceHandle._(descriptor);
}

/// Binding `example-iot/device-link` (export `API_link`), generic arity 1.
class APILink<T> {
  APILink._(this.descriptor, this.decode);

  /// The validated `{"__blocks": …}` descriptor.
  final Map<String, dynamic> descriptor;

  /// Decodes one payload as `T`.
  final T Function(Map<String, dynamic>) decode;

  factory APILink.fromBlocksDescriptor(
    Map<String, dynamic> descriptor,
    T Function(Map<String, dynamic>) decode,
  ) => APILink._(descriptor, decode);
}
