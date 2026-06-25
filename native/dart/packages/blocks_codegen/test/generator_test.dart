import 'package:blocks_codegen/src/builder.dart';
import 'package:blocks_codegen/src/generator.dart';
import 'package:test/test.dart';

void main() {
  const gen = DartCodeGenerator();

  group('basic generation', () {
    test('generates Blocks class with namespace accessors', () {
      final output = gen.generate(CodegenModel(
        title: 'test',
        version: '1.0',
        namespaces: [
          Namespace(name: 'api', operations: [
            Operation(
                name: 'greet',
                fullName: 'api.greet',
                params: [
                  OperationParam(
                      name: 'name',
                      type: const PrimitiveType('String'),
                      isRequired: true)
                ],
                result: const PrimitiveType('String')),
          ]),
        ],
        types: {},
      ));
      expect(output, contains('class Blocks {'));
      expect(output, contains('late final ApiApi api;'));
      expect(output, contains("Blocks({required String baseUrl"));
      expect(output, contains("_client.call('api.greet'"));
    });
  });

  group('sealed class generation', () {
    test('generates sealed class with fromJson switch', () {
      final output = gen.generate(CodegenModel(
        title: 'test',
        version: '1.0',
        namespaces: [],
        types: {
          'Input':
              SealedClassType(name: 'Input', discriminant: 'action', variants: [
            SealedVariant(discriminantValue: 'a', className: 'AInput', fields: [
              RecordField(
                  name: 'x',
                  type: const PrimitiveType('String'),
                  isRequired: true),
            ]),
            SealedVariant(
                discriminantValue: 'b', className: 'BInput', fields: []),
          ]),
        },
      ));
      expect(output, contains('sealed class Input {'));
      expect(output, contains("case 'a': return AInput.fromJson(json);"));
      expect(output, contains("case 'b': return BInput.fromJson(json);"));
      expect(output, contains('class AInput extends Input {'));
      expect(output, contains("'action': 'a',"));
    });
  });

  group('transferable hydration', () {
    test('emits RealtimeChannel.fromJson for realtime/channel', () {
      final output = gen.generate(CodegenModel(
        title: 'test',
        version: '1.0',
        namespaces: [
          Namespace(name: 'api', operations: [
            Operation(
                name: 'getChannel',
                fullName: 'api.getChannel',
                params: [],
                result: TransferableType(
                    blocksType: 'realtime/channel',
                    typeArgs: [const PrimitiveType('dynamic')])),
          ]),
        ],
        types: {},
      ));
      expect(output, contains('Future<RealtimeChannel<dynamic>> getChannel()'));
      expect(output,
          contains('RealtimeChannel.fromJson(result as Map<String, dynamic>'));
    });

    test('emits FileDownloadHandle.fromJson for file-bucket/download', () {
      final output = gen.generate(CodegenModel(
        title: 'test',
        version: '1.0',
        namespaces: [
          Namespace(name: 'api', operations: [
            Operation(
                name: 'download',
                fullName: 'api.download',
                params: [],
                result:
                    const TransferableType(blocksType: 'file-bucket/download')),
          ]),
        ],
        types: {},
      ));
      expect(output, contains('Future<FileDownloadHandle> download()'));
      expect(
          output,
          contains(
              'FileDownloadHandle.fromJson(result as Map<String, dynamic>)'));
    });
  });

  group('tuple generation', () {
    test('emits Dart record type for TupleType', () {
      final output = gen.generate(CodegenModel(
        title: 'test',
        version: '1.0',
        namespaces: [
          Namespace(name: 'api', operations: [
            Operation(
                name: 'getCoords',
                fullName: 'api.getCoords',
                params: [],
                result: TupleType([
                  const PrimitiveType('num'),
                  const PrimitiveType('num'),
                  const PrimitiveType('String')
                ])),
          ]),
        ],
        types: {},
      ));
      expect(output, contains('Future<(num, num, String)> getCoords()'));
      expect(output, contains('(result as List<dynamic>)[0] as num'));
      expect(output, contains('(result as List<dynamic>)[1] as num'));
      expect(output, contains('(result as List<dynamic>)[2] as String'));
    });

    test('emits tuple toJson as list for params', () {
      final output = gen.generate(CodegenModel(
        title: 'test',
        version: '1.0',
        namespaces: [
          Namespace(name: 'api', operations: [
            Operation(
                name: 'setCoords',
                fullName: 'api.setCoords',
                params: [
                  OperationParam(
                      name: 'coords',
                      type: TupleType([
                        const PrimitiveType('num'),
                        const PrimitiveType('String')
                      ]),
                      isRequired: true)
                ],
                result: const PrimitiveType('void')),
          ]),
        ],
        types: {},
      ));
      expect(output, contains(r"'coords': [coords.$1, coords.$2]"));
    });
  });
}
