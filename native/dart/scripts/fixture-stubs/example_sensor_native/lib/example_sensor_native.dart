/// Compile-only stub of codegen fixture 27's declared `example-sensor-native`
/// package: the `blocks-transferable-v1` factory its binding names.
library;

/// Binding `example-sensor/stream`, generic arity 0.
class SensorStream {
  SensorStream._(this.descriptor);

  /// The validated `{"__blocks": …}` descriptor.
  final Map<String, dynamic> descriptor;

  factory SensorStream.fromBlocksDescriptor(Map<String, dynamic> descriptor) =>
      SensorStream._(descriptor);
}
