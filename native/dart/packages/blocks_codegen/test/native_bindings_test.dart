import 'dart:convert';
import 'dart:io';

import 'package:blocks_codegen/src/builder.dart';
import 'package:blocks_codegen/src/dart_source.dart';
import 'package:blocks_codegen/src/generator.dart';
import 'package:blocks_codegen/src/parser.dart';
import 'package:test/test.dart';

/// The third-party tag the probes bind. A built-in tag short-circuits binding
/// resolution, so a probe using one cannot reach the rule under test.
const _tag = 'example-iot/device-link';

const _messageSchema = {
  'type': 'object',
  'properties': {
    'temperature': {'type': 'number'},
  },
  'required': ['temperature'],
};

void main() {
  group('declared binding emits a typed result', () {
    test('arity zero emits the declared import, type and factory', () {
      final model = _build(_specJson(extras: _catalogs()));
      final output = _generate(model);

      expect(
        output,
        contains(
          "import 'package:example_iot_native/example_iot_native.dart' "
          'show DeviceLink;',
        ),
      );
      expect(output, contains('Future<DeviceLink> connectDevice()'));
      expect(
        output,
        contains(
          "return DeviceLink.fromBlocksDescriptor(validateTransferableDescriptor(result, expectedTag: '$_tag'));",
        ),
      );
      expect(output, isNot(contains('UnknownTransferable')));
      expect(model.warnings, isEmpty);
    });

    test('arity one specializes the type and passes the payload decoder', () {
      final model = _build(_arityOneSpec());
      final output = _generate(model);

      expect(
        output,
        contains('Future<DeviceLink<ConnectDeviceResultMessage>> '),
      );
      expect(
        output,
        contains(
          "return DeviceLink<ConnectDeviceResultMessage>.fromBlocksDescriptor(validateTransferableDescriptor(result, expectedTag: '$_tag'), (json) => ConnectDeviceResultMessage.fromJson(json));",
        ),
      );
      expect(model.warnings, isEmpty);
    });

    test('the runtime import is kept and declared imports are sorted', () {
      final output = _generate(_build(_specJson(extras: _catalogs())));
      final directives = const LineSplitter()
          .convert(output)
          .where((l) => l.startsWith('import ') || l.startsWith('export '))
          .toList();

      expect(directives, [
        "import 'package:blocks_runtime/blocks_runtime.dart';",
        "import 'package:example_iot_native/example_iot_native.dart' "
            'show DeviceLink;',
        "export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;",
        "export 'package:blocks_runtime/blocks_runtime.dart' show RealtimeChannel, FileDownloadHandle, FileUploadHandle;",
      ]);
    });

    test('directives sort alphabetically, runtime included', () {
      // `a_iot_native` sorts before `blocks_runtime`, so emitting the runtime
      // first would break `directives_ordering` in the generated client.
      expect(_directives(_generateFrom(_twoBoundSpec(name: 'a_iot_native'))), [
        "import 'package:a_iot_native/a_iot_native.dart' "
            'show DeviceLink, SensorStream;',
        "import 'package:blocks_runtime/blocks_runtime.dart';",
      ]);
    });

    test('a renamed arity-one payload binds the renamed model', () {
      final output = _generateFrom(_renamedPayloadSpec());

      // `Msg` is claimed by api.kind's result, so the `$ref`ed schema becomes
      // `Msg2`. The type arg and its decoder must both follow the rename, or
      // the client hydrates with whatever kept the old name.
      expect(output, contains('Future<DeviceLink<Msg2>> connectDevice()'));
      expect(output, contains('(json) => Msg2.fromJson(json)'));
      expect(output, isNot(contains('(json) => Msg.fromJson(json)')));
      expect(output, isNot(contains('DeviceLink<Msg>')));
    });

    test('a negative generic arity is an error', () {
      expect(
        () => _build(
          _specJson(extras: _catalogs(bindings: [_binding(genericArity: -1)])),
        ),
        _throwsFormat('to be 0 or 1'),
      );
    });

    test('a quote in a string pattern is escaped, not raw', () {
      final output = _generateFrom(_patternSpec("it's|x"));

      expect(output, contains(r"RegExp('it\'s|x')"));
      expect(output, isNot(contains("RegExp(r'it")));
    });

    test('a pattern that is not a regular expression is an error', () {
      for (final pattern in [r'abc\', '(unclosed', 'a{2,1}', '[z-a]']) {
        expect(
          () => _build(_patternSpec(pattern)),
          _throwsFormat('to be a regular expression'),
          reason: pattern,
        );
      }
    });

    test('a carriage return in a pattern cannot end the raw literal', () {
      // A bare CR has no quote and no newline, so it must still take the
      // escaped branch: a raw string cannot carry one.
      final output = _generateFrom(_patternSpec('^a\rb\$'));

      expect(output, contains(r"RegExp('^a\rb"));
      expect(output, isNot(contains("RegExp(r'^a")));
    });

    test('a namespace segment that is not a Dart identifier is an error', () {
      for (final name in ['api.f\u00f3o.m', '.foo.m', 'foo..m', 'api..foo.m']) {
        expect(
          () => _generateFrom(_namespaceSpec(name)),
          _throwsFormat('cannot name the Dart class and field it emits'),
          reason: name,
        );
      }
    });

    test('two namespaces differing only by punctuation are an error', () {
      expect(
        () => _generateFrom(_collidingNamespaceSpec()),
        _throwsFormat('both generate ApiFooApi'),
      );
    });

    test('a dotted namespace yields one class and one identifier', () {
      final output = _generateFrom(_namespaceSpec('api.foo.bar'));

      expect(output, contains('class ApiFooApi {'));
      expect(output, contains('late final ApiFooApi apiFoo;'));
      expect(output, isNot(contains('Api.fooApi')));
    });

    test('a declared package cannot be the runtime the client imports', () {
      expect(
        () => _build(
          _specJson(
            extras: _catalogs(platforms: _dartPlatform(name: 'blocks_runtime')),
          ),
        ),
        _throwsFormat("other than 'blocks_runtime'"),
      );
    });

    test('an export resolving to a dart:core type is rejected', () {
      for (final export in ['string', 'object', 'future', 'map', 'list']) {
        expect(
          () => _build(_specWith(_binding(export: export))),
          _throwsFormat('dart:core or dart:async already declares'),
          reason: export,
        );
      }
    });

    test('a carriage return in an identity cannot forge a second line', () {
      final model = _build(
        _specJson(
          extras: _catalogs(
            packages: {
              'ex\rWarning: forged': {
                'platforms': {'dart': _dartPackage()},
              },
              'example-iot-native': {
                'platforms': {'dart': _dartPackage()},
              },
            },
          ),
        ),
      );

      final forged = model.warnings.where((w) => w.contains('forged'));
      expect(forged, hasLength(1));
      expect(forged.single.split('\r'), hasLength(1));
    });

    test('every type the emitted client references is covered', () {
      // Read the sink, not the generator: any capitalised name the output
      // references, other than one it declares itself or shows from a bound
      // package, must sit in a collision set or a `show` of it would shadow.
      // Catches a new emission of a name the sets omit; cannot flag a member
      // the output never references.
      final output = [
        _twoBoundSpec(),
        _arityOneSpec(),
        _unionSpec(_binding()),
        _specJson(
          params: [
            {
              'name': 'label',
              'required': true,
              'schema': {'type': 'string', 'minLength': 3},
            },
          ],
          extras: _catalogs(),
        ),
      ].map(_generateFrom).join('\n');
      final code = output
          .split('\n')
          .where((line) => !line.trimLeft().startsWith('//'))
          .join('\n')
          .replaceAll(RegExp(r"'(?:[^'\\\n]|\\.)*'"), "''")
          .replaceAll(RegExp(r'"(?:[^"\\\n]|\\.)*"'), "''");

      final shown = RegExp(r"^import '[^']+' show ([^;]+);", multiLine: true)
          .allMatches(output)
          .expand((m) => m.group(1)!.split(',').map((n) => n.trim()))
          .toSet();
      // Every position a type can occupy: call, generic open, member access,
      // generic close, generic comma, statement end, index close, nullable,
      // and a bare annotation. Requiring a lowercase letter drops the all-caps
      // enum constants the generator emits; an all-caps type name would be
      // missed, which `_exportTypeName` can produce from an all-caps export.
      final referenced = RegExp(
        r'\b([A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*|[A-Z][a-z][A-Za-z0-9]*)'
        r'\s*(?:[(<.>,;)}{\]?]|\s+[A-Za-z_])',
      ).allMatches(code).map((m) => m.group(1)!).toSet();

      expect(referenced, contains('BlocksClient'), reason: 'extraction works');
      expect(
        referenced
            .difference(declaredTypeNames(code))
            .difference(shown)
            .difference(dartCoreTypeNames)
            .difference(blocksRuntimeTypeNames),
        isEmpty,
      );
    });
    test('the declared import shows only the bound type', () {
      final output = _generate(_build(_specJson(extras: _catalogs())));

      expect(
        output,
        contains(
          "import 'package:example_iot_native/example_iot_native.dart' "
          'show DeviceLink;',
        ),
      );
      expect(
        output,
        isNot(
          contains(
            "import 'package:example_iot_native/example_iot_native.dart';",
          ),
        ),
      );
    });

    test('a non-camel export becomes an upper camel type name', () {
      final output = _generate(
        _build(_specWith(_binding(export: 'device-link'))),
      );

      expect(output, contains('Future<DeviceLink> connectDevice()'));
    });

    test('a declared package is not imported when no result uses its tag', () {
      final output = _generate(
        _build(
          _specJson(
            resultSchema: const {'type': 'string'},
            extras: _catalogs(),
          ),
        ),
      );

      expect(output, isNot(contains('example_iot_native')));
    });
  });

  group('declared binding does not apply', () {
    test('a built-in tag keeps its hard-coded runtime type', () {
      final output = _generate(
        _build(
          _specJson(
            resultSchema: const {'x-blocks-transferable': 'realtime/channel'},
            extras: _catalogs(bindings: [_binding(tag: 'realtime/channel')]),
          ),
        ),
      );

      expect(output, contains('Future<RealtimeChannel<dynamic>> '));
      expect(output, contains('RealtimeChannel.fromJson('));
      expect(output, isNot(contains('example_iot_native')));
      expect(output, isNot(contains('fromBlocksDescriptor')));
    });

    test('a tag differing only in case falls back', () {
      final model = _build(_specWith(_binding(tag: 'Example-IoT/Device-Link')));

      expect(_generate(model), contains('Future<UnknownTransferable> '));
      expect(model.warnings, contains(contains('AWSBLOCKS-NATIVE-001')));
    });

    test('a tag differing only by trailing whitespace falls back', () {
      final output = _generate(_build(_specWith(_binding(tag: '$_tag '))));

      expect(output, contains('Future<UnknownTransferable> '));
    });

    test('a tag that only normalises to the method\'s falls back', () {
      // Fullwidth `e` and `-`, which NFKC-fold to the exact tag. Dart compares
      // code units, so the lookup must not match what a normalising one would.
      const folding = '\uff45xample-iot/device\uff0dlink';
      final output = _generate(_build(_specWith(_binding(tag: folding))));

      expect(output, contains('Future<UnknownTransferable> '));
    });

    test('a package offered on no Dart platform falls back', () {
      final model = _build(
        _specJson(
          extras: _catalogs(
            platforms: const {
              'swift': {
                'package': {
                  'identity': 'example-iot-native',
                  'product': 'ExampleIotNative',
                  'module': 'ExampleIotNative',
                },
              },
            },
          ),
        ),
      );

      expect(_generate(model), contains('Future<UnknownTransferable> '));
      expect(model.warnings, contains(contains('AWSBLOCKS-NATIVE-001')));
    });

    test('an opted-out package falls back', () {
      final model = CodegenModelBuilder(
        optedOutPackages: const {'example-iot-native'},
      ).build(const OpenRpcParser().parse(_specJson(extras: _catalogs())));

      expect(_generate(model), contains('Future<UnknownTransferable> '));
      expect(model.warnings, contains(contains('AWSBLOCKS-NATIVE-001')));
    });

    test('opting out of another identity leaves the binding applied', () {
      final model = CodegenModelBuilder(
        optedOutPackages: const {'some-other-native'},
      ).build(const OpenRpcParser().parse(_specJson(extras: _catalogs())));

      expect(_generate(model), contains('Future<DeviceLink> '));
    });

    test('a kind other than transferable falls back', () {
      final model = _build(_specWith(_binding(kind: 'facade')));

      expect(_generate(model), contains('Future<UnknownTransferable> '));
    });

    test('a nested bound transferable stays dynamic', () {
      final model = _build(
        _specJson(
          resultSchema: const {
            'type': 'object',
            'properties': {
              'link': {'x-blocks-transferable': _tag},
            },
            'required': ['link'],
          },
          extras: _catalogs(),
        ),
      );
      final output = _generate(model);

      expect(output, contains('final dynamic link;'));
      expect(output, isNot(contains('fromBlocksDescriptor')));
      expect(model.warnings, isEmpty);
    });

    test('a kind schema 1 does not define reports AWSBLOCKS-NATIVE-004', () {
      final model = _build(
        _specWith(_binding(id: 'typo', kind: 'transferrable')),
      );

      expect(
        model.warnings.first,
        "AWSBLOCKS-NATIVE-004: binding 'typo' declares kind 'transferrable', "
        'which schema 1 does not define; ignored on dart.',
      );
    });

    test('a newline in a reported binding id cannot split the diagnostic', () {
      final model = _build(
        _specWith(
          _binding(id: 'a\nAWSBLOCKS-NATIVE-001: forged', kind: 'facade'),
        ),
      );

      final reported = model.warnings.first;
      expect(reported, startsWith('AWSBLOCKS-NATIVE-004: '));
      expect(reported, contains(r'a\nAWSBLOCKS-NATIVE-001: forged'));
      expect(reported, isNot(contains('\n')));
    });

    test('an undefined kind whose export cannot name a type is an error', () {
      expect(
        () => _build(_specWith(_binding(kind: 'facade', export: '_private'))),
        throwsA(
          isA<FormatException>().having(
            (e) => e.message,
            'message',
            contains("export '_private' does not name a public Dart type"),
          ),
        ),
      );
    });

    test('a newline in an operation name cannot split the diagnostic', () {
      final model = _build(
        _specJson(methodName: 'api.get\nAWSBLOCKS-NATIVE-999: forged'),
      );

      final reported = model.warnings.firstWhere(
        (w) => w.startsWith('AWSBLOCKS-NATIVE-001'),
      );
      expect(reported, contains(r'api.get\nAWSBLOCKS-NATIVE-999: forged'));
      expect(reported, isNot(contains('\n')));
    });

    test('a nullable bound direct result stays dynamic', () {
      final model = _build(
        _specJson(
          resultSchema: const {
            'oneOf': [
              {'x-blocks-transferable': _tag},
              {'type': 'null'},
            ],
          },
          extras: _catalogs(),
        ),
      );
      final output = _generate(model);

      expect(output, contains('Future<dynamic?> '));
      expect(output, isNot(contains('fromBlocksDescriptor')));
      expect(model.warnings, isEmpty);
    });

    test('a bound result is settled at its own position in the namespace', () {
      // The decodability pass indexes each operation inside its namespace, so
      // a bound result that is not the first method must still be reached.
      final model = _build(_secondMethodBoundSpec());

      expect(
        _generate(model),
        contains('Future<UnknownTransferable> streamed('),
      );
      expect(
        model.warnings,
        contains(contains('AWSBLOCKS-NATIVE-001: api.streamed')),
      );
    });

    test('an arity-one payload with no decoder falls back', () {
      final model = _build(
        _specJson(
          resultSchema: const {
            'x-blocks-transferable': _tag,
            'x-blocks-type-args': [
              {'type': 'string'},
            ],
          },
          extras: _catalogs(bindings: [_binding(genericArity: 1)]),
        ),
      );

      expect(_generate(model), contains('Future<UnknownTransferable> '));
      expect(model.warnings, contains(contains('AWSBLOCKS-NATIVE-001')));
    });

    test('the built-in arity-one path keeps its declared type', () {
      final model = _build(
        _specJson(
          resultSchema: const {
            'x-blocks-transferable': 'realtime/channel',
            'x-blocks-type-args': [
              {'type': 'string'},
            ],
          },
        ),
      );

      expect(_generate(model), contains('Future<RealtimeChannel<String>> '));
      expect(model.warnings, contains(contains('AWSBLOCKS-NATIVE-002')));
    });
  });

  group('a bound export name must be free in the generated library', () {
    test('a name the runtime exports is an error, not an ambiguous import', () {
      expect(
        () => _build(_specWith(_binding(export: 'fileDownloadHandle'))),
        _throwsFormat(
          'package:blocks_runtime/blocks_runtime.dart already declares '
          'FileDownloadHandle',
        ),
      );
    });

    test('two exports in one package claiming one type name is an error', () {
      expect(
        () => _build(
          _specJson(
            extras: _catalogs(
              bindings: [
                _binding(export: 'device-link'),
                _binding(tag: 'example-iot/device-port', export: 'device_link'),
              ],
            ),
          ),
        ),
        _throwsFormat('already declares DeviceLink'),
      );
    });

    test('two packages exporting the same type name is an error', () {
      final spec = _specJson(
        extras: _catalogs(
          packages: {
            'a-native': {
              'platforms': {'dart': _dartPackage(name: 'a_native')},
            },
            'b-native': {
              'platforms': {'dart': _dartPackage(name: 'b_native')},
            },
          },
          bindings: [
            _binding(package: 'a-native'),
            _binding(tag: 'other/link', package: 'b-native'),
          ],
        ),
      );
      expect(
        () => _build(spec),
        _throwsFormat("export 'deviceLink' in package 'a-native'"),
      );
    });

    test('one package exporting the same type on two tags is allowed', () {
      final model = _build(
        _specJson(
          extras: _catalogs(
            bindings: [
              _binding(),
              _binding(tag: 'other/link'),
            ],
          ),
        ),
      );

      expect(_generate(model), contains('Future<DeviceLink> connectDevice()'));
    });

    test('a name a named schema declares is an error', () {
      expect(
        () => _generateFrom(
          _specJson(
            extras: _catalogs(),
            schemas: const {
              'DeviceLink': {
                'type': 'object',
                'properties': {
                  'id': {'type': 'string'},
                },
                'required': ['id'],
              },
            },
          ),
        ),
        _throwsFormat('the generated client also declares DeviceLink'),
      );
    });

    test('a synthesized result name is an error', () {
      expect(
        () => _generateFrom(_twoMethodSpec(_binding(export: 'telemetry'))),
        _throwsFormat('the generated client also declares Telemetry'),
      );
    });

    test('a synthesized param object name is an error', () {
      expect(
        () => _generateFrom(
          _specJson(
            params: const [
              {
                'name': 'link',
                'required': true,
                'schema': {
                  'type': 'object',
                  'properties': {
                    'id': {'type': 'string'},
                  },
                  'required': ['id'],
                },
              },
            ],
            extras: _catalogs(
              bindings: [_binding(export: 'apiConnectDeviceLink')],
            ),
          ),
        ),
        _throwsFormat('also declares ApiConnectDeviceLink'),
      );
    });

    test('a synthesized type-arg model name is an error', () {
      expect(
        () => _generateFrom(
          _specJson(
            resultSchema: const {
              'x-blocks-transferable': _tag,
              'x-blocks-type-args': [_messageSchema],
            },
            extras: _catalogs(
              bindings: [
                _binding(export: 'connectDeviceResultMessage', genericArity: 1),
              ],
            ),
          ),
        ),
        _throwsFormat('also declares ConnectDeviceResultMessage'),
      );
    });

    test('the root client and namespace class names are errors', () {
      for (final entry in const {
        'blocks': 'Blocks',
        'apiApi': 'ApiApi',
      }.entries) {
        expect(
          () => _generateFrom(_specWith(_binding(export: entry.key))),
          _throwsFormat('also declares ${entry.value}'),
          reason: entry.key,
        );
      }
    });

    test('the Servers class name is an error', () {
      expect(
        () => _generateFrom(
          _specJson(
            extras: {
              'servers': const [
                {'name': 'prod', 'url': 'https://example.com'},
              ],
              ..._catalogs(bindings: [_binding(export: 'servers')]),
            },
          ),
        ),
        _throwsFormat('also declares Servers'),
      );
    });

    test('a sealed variant class name is an error', () {
      expect(
        () => _generateFrom(_unionSpec(_binding(export: 'createInput'))),
        _throwsFormat('also declares CreateInput'),
      );
    });

    test('a sealed parent class name is an error', () {
      expect(
        () => _generateFrom(_unionSpec(_binding(export: 'apiDoActionInput'))),
        _throwsFormat('also declares ApiDoActionInput'),
      );
    });

    test('an enum name is an error', () {
      expect(
        () => _generateFrom(
          _specJson(
            extras: _catalogs(bindings: [_binding(export: 'severity')]),
            schemas: const {
              'Severity': {
                'type': 'string',
                'enum': ['low', 'high'],
              },
            },
          ),
        ),
        _throwsFormat('also declares Severity'),
      );
    });

    test('an inert binding colliding with a generated name is ignored', () {
      final model = _build(
        _twoMethodSpec(
          _binding(),
          alsoBind: [_binding(tag: 'example-iot/unused', export: 'telemetry')],
        ),
      );
      final output = _generate(model);

      expect(output, contains('class Telemetry {'));
      expect(output, contains('Future<DeviceLink> connectDevice()'));
      expect(output, contains('Future<Telemetry> readTelemetry()'));
    });

    test('an inert binding still fails on a runtime-name collision', () {
      expect(
        () => _build(
          _specWith(
            _binding(tag: 'example-iot/unused', export: 'fileDownloadHandle'),
          ),
        ),
        _throwsFormat('already declares FileDownloadHandle'),
      );
    });

    test('a schema the bindings do not name is emitted unchanged', () {
      final output = _generate(
        _build(
          _specJson(
            resultSchema: const {r'$ref': '#/components/schemas/Telemetry'},
            extras: _catalogs(),
            schemas: const {
              'Telemetry': {
                'type': 'object',
                'properties': {
                  'serial': {'type': 'string'},
                },
                'required': ['serial'],
              },
            },
          ),
        ),
      );

      expect(output, contains('class Telemetry {'));
      expect(output, contains('Future<Telemetry> connectDevice()'));
    });

    test('blocksRuntimeTypeNames matches the runtime library it guards', () {
      final runtimeLib = File(
        '${Directory.current.path}/../blocks_runtime/lib/blocks_runtime.dart',
      );
      expect(
        runtimeLib.existsSync(),
        isTrue,
        reason:
            'blocksRuntimeTypeNames is unverifiable without '
            '${runtimeLib.path}; this guard must not be skippable',
      );
      final source = runtimeLib.readAsStringSync();
      final exported = RegExp(
        r"^export '([^']+)'[^;]*;",
        multiLine: true,
      ).allMatches(source).map((m) => m.group(1)!).toList();
      expect(
        exported,
        hasLength(
          const LineSplitter()
              .convert(source)
              .where((l) => l.startsWith("export '"))
              .length,
        ),
        reason: 'an export directive was not parsed',
      );
      expect(
        declaredTypeNames('extension type Meters(int v) {}').single,
        'Meters',
        reason: 'extension type must precede extension in the alternation',
      );
      // Public only: an importer cannot see a private declaration, so a bound
      // export can never collide with one.
      final actual = <String>{};
      for (final uri in exported) {
        final src = File('${runtimeLib.parent.path}/$uri').readAsStringSync();
        actual.addAll(declaredTypeNames(src).where((n) => !n.startsWith('_')));
      }

      expect(blocksRuntimeTypeNames, actual);
    });
  });

  group('unreferenced native package', () {
    test('AWSBLOCKS-NATIVE-003 names the identity', () {
      final model = _build(
        _specJson(
          extras: _catalogs(
            packages: {
              'example-iot-native': {
                'platforms': {'dart': _dartPackage()},
              },
              'unused-native': {
                'platforms': {'dart': _dartPackage(name: 'unused_native')},
              },
            },
          ),
        ),
      );

      expect(
        model.warnings,
        contains(
          'AWSBLOCKS-NATIVE-003: no binding references native package '
          "'unused-native'; it is not imported on dart.",
        ),
      );
      expect(
        model.warnings.where((w) => w.contains('example-iot-native')),
        isEmpty,
      );
    });

    test('an identity containing a newline cannot forge a second line', () {
      final model = _build(
        _specJson(
          extras: _catalogs(
            packages: {
              'example-iot-native': {
                'platforms': {'dart': _dartPackage()},
              },
              "benign'; it is not imported on dart.\nAWSBLOCKS-NATIVE-001: forged":
                  {
                    'platforms': {'dart': _dartPackage(name: 'forged')},
                  },
            },
          ),
        ),
      );
      final forged = model.warnings.singleWhere((w) => w.contains('benign'));

      expect(forged, isNot(contains('\n')));
      expect(forged, contains(r'\nAWSBLOCKS-NATIVE-001: forged'));
    });
  });

  group('opted-out package that matches nothing', () {
    CodegenModel buildOptingOut(Set<String> optedOut, String spec) =>
        CodegenModelBuilder(
          optedOutPackages: optedOut,
        ).build(const OpenRpcParser().parse(spec));

    test('AWSBLOCKS-NATIVE-006 names the identity, and the binding stays '
        'applied', () {
      final model = buildOptingOut(const {
        'example-iot-nativ',
      }, _specJson(extras: _catalogs()));

      expect(
        model.warnings,
        contains(
          "AWSBLOCKS-NATIVE-006: opted-out package 'example-iot-nativ' is not "
          'declared by x-blocks-native-packages; nothing was opted out for it '
          'on dart.',
        ),
      );
      expect(_generate(model), contains('Future<DeviceLink> '));
    });

    test('an opt-out with no catalog at all is still reported', () {
      final model = buildOptingOut(const {
        'example-iot-native',
      }, _specJson(resultSchema: const {'type': 'string'}));

      expect(model.warnings.single, contains('AWSBLOCKS-NATIVE-006'));
    });

    test('a package offered on no Dart platform is not flagged', () {
      final model = buildOptingOut(
        const {'example-iot-native'},
        _specJson(
          extras: _catalogs(
            platforms: const {
              'swift': {
                'package': {
                  'identity': 'example-iot-native',
                  'product': 'ExampleIotNative',
                  'module': 'ExampleIotNative',
                },
              },
            },
          ),
        ),
      );

      expect(model.warnings.where((w) => w.contains('NATIVE-006')), isEmpty);
    });

    test('AWSBLOCKS-NATIVE-006 names every undeclared identity in sorted '
        'order', () {
      final model = buildOptingOut(
        const {'zz-native', 'aa-native'},
        _specJson(
          extras: _catalogs(
            packages: {
              'example-iot-native': {
                'platforms': {'dart': _dartPackage()},
              },
              'unused-native': {
                'platforms': {'dart': _dartPackage(name: 'unused_native')},
              },
            },
          ),
        ),
      );

      expect(model.warnings.map((w) => w.split("'")[1]), [
        'aa-native',
        'zz-native',
        'unused-native',
      ]);
    });

    test('an opted-out identity containing a newline cannot forge a second '
        'line', () {
      final model = buildOptingOut({
        "benign' is not declared by x-blocks-native-packages; nothing was "
            'opted out for it on dart.\nAWSBLOCKS-NATIVE-001: forged',
      }, _specJson(extras: _catalogs()));
      final forged = model.warnings.singleWhere((w) => w.contains('benign'));

      expect(forged, isNot(contains('\n')));
      expect(forged, contains(r'\nAWSBLOCKS-NATIVE-001: forged'));
    });
  });

  group('the generated header cannot carry a declaration', () {
    test('info.title and info.version are escaped to one comment line', () {
      final output = _generate(
        _build(
          jsonEncode({
            'openrpc': '1.3.2',
            'info': {
              'title': 'Legit\nvoid pwnedViaTitle() {}\n// tail',
              'version': '1.0.0\nvoid pwnedViaVersion() {}',
            },
            'methods': [
              {
                'name': 'api.ping',
                'params': <Map<String, dynamic>>[],
                'result': {
                  'name': 'R',
                  'schema': {'type': 'string'},
                },
              },
            ],
          }),
        ),
      );
      final header = const LineSplitter().convert(output)[2];

      expect(header, startsWith('// Source: '));
      expect(header, contains(r'\nvoid pwnedViaTitle() {}'));
      expect(output, isNot(contains('\nvoid pwnedViaTitle() {}')));
      expect(output, isNot(contains('\nvoid pwnedViaVersion() {}')));
    });
  });

  group('malformed catalog metadata is a generation error', () {
    test('a packages catalog that is not an object', () {
      expect(
        () => _build(
          _specJson(extras: const {'x-blocks-native-packages': 'nope'}),
        ),
        _throwsFormat("Expected 'x-blocks-native-packages' to be an object"),
      );
    });

    test('an unsupported packages schemaVersion', () {
      expect(
        () => _build(
          _specJson(
            extras: const {
              'x-blocks-native-packages': {
                'schemaVersion': 2,
                'packages': <String, dynamic>{},
              },
            },
          ),
        ),
        _throwsFormat(
          "Unsupported 'x-blocks-native-packages.schemaVersion': 2",
        ),
      );
    });

    test('an unsupported bindings schemaVersion', () {
      expect(
        () => _build(
          _specJson(
            extras: const {
              'x-blocks-native-bindings': {
                'schemaVersion': 2,
                'bindings': <Map<String, dynamic>>[],
              },
            },
          ),
        ),
        _throwsFormat(
          "Unsupported 'x-blocks-native-bindings.schemaVersion': 2",
        ),
      );
    });

    test('a packages map that is not an object', () {
      expect(
        () => _build(
          _specJson(
            extras: const {
              'x-blocks-native-packages': {
                'schemaVersion': 1,
                'packages': 'nope',
              },
            },
          ),
        ),
        _throwsFormat(
          "Expected 'x-blocks-native-packages.packages' to be an object",
        ),
      );
    });

    test('a package entry missing platforms', () {
      expect(
        () => _build(
          _specJson(
            extras: const {
              'x-blocks-native-packages': {
                'schemaVersion': 1,
                'packages': {'example-iot-native': <String, dynamic>{}},
              },
            },
          ),
        ),
        _throwsFormat('.example-iot-native.platforms'),
      );
    });

    test('a dart platform entry missing its package object', () {
      expect(
        () => _build(
          _specJson(
            extras: _catalogs(platforms: const {'dart': <String, dynamic>{}}),
          ),
        ),
        _throwsFormat('.platforms.dart.package'),
      );
    });

    test('a dart package missing name', () {
      expect(
        () => _build(
          _specJson(
            extras: _catalogs(
              platforms: const {
                'dart': {
                  'package': {'library': 'example_iot_native.dart'},
                },
              },
            ),
          ),
        ),
        _throwsFormat(".platforms.dart.package.name' to be a non-empty string"),
      );
    });

    test('a dart package with a blank library', () {
      expect(
        () => _build(
          _specJson(
            extras: _catalogs(
              platforms: const {
                'dart': {
                  'package': {'name': 'example_iot_native', 'library': ''},
                },
              },
            ),
          ),
        ),
        _throwsFormat(
          ".platforms.dart.package.library' to be a non-empty string",
        ),
      );
    });

    test('a package name that is not a pub package name', () {
      for (final name in const [
        '../../../etc/evil',
        "p'; void pwned() {} import 'dart:io",
        'Example_Iot',
        '2device',
      ]) {
        expect(
          () => _build(
            _specJson(
              extras: _catalogs(platforms: _dartPlatform(name: name)),
            ),
          ),
          _throwsFormat('to be a pub package name'),
          reason: name,
        );
      }
    });

    test('a library that is not a .dart path inside lib/', () {
      for (final library in const [
        "x.dart'; void pwned() { } import 'dart:io",
        '../../secrets.dart',
        'a/../b.dart',
        '/absolute.dart',
        'example_iot_native',
        'Example.dart',
        '.hidden.dart',
        'lib/x.dart',
      ]) {
        expect(
          () => _build(
            _specJson(
              extras: _catalogs(platforms: _dartPlatform(library: library)),
            ),
          ),
          _throwsFormat('to be a .dart path inside lib/'),
          reason: library,
        );
      }
    });

    test('a dotted segment is accepted', () {
      final output = _generate(
        _build(
          _specJson(
            extras: _catalogs(platforms: _dartPlatform(library: 'api.g.dart')),
          ),
        ),
      );

      expect(
        output,
        contains(
          "import 'package:example_iot_native/api.g.dart' show DeviceLink;",
        ),
      );
    });

    test('a library in a lib/ subdirectory is accepted', () {
      final output = _generate(
        _build(
          _specJson(
            extras: _catalogs(
              platforms: _dartPlatform(library: 'src/public_api.dart'),
            ),
          ),
        ),
      );

      expect(
        output,
        contains(
          "import 'package:example_iot_native/src/public_api.dart' "
          'show DeviceLink;',
        ),
      );
    });

    test('a bindings catalog whose bindings is not an array', () {
      expect(
        () => _build(
          _specJson(
            extras: const {
              'x-blocks-native-bindings': {
                'schemaVersion': 1,
                'bindings': <String, dynamic>{},
              },
            },
          ),
        ),
        _throwsFormat(
          "Expected 'x-blocks-native-bindings.bindings' to be an array",
        ),
      );
    });

    test('a binding that is not an object', () {
      expect(
        () => _build(
          _specJson(
            extras: const {
              'x-blocks-native-bindings': {
                'schemaVersion': 1,
                'bindings': ['nope'],
              },
            },
          ),
        ),
        _throwsFormat("Expected 'x-blocks-native-bindings.bindings[0]'"),
      );
    });

    test('a binding with a blank tag', () {
      expect(
        () => _build(_specWith(_binding(tag: ''))),
        _throwsFormat(".tag' to be a non-empty string"),
      );
    });

    test('a binding with a blank export', () {
      expect(
        () => _build(_specWith(_binding(export: ''))),
        _throwsFormat(".export' to be a non-empty string"),
      );
    });

    test('a binding with a missing id', () {
      final binding = _binding()..remove('id');
      expect(
        () => _build(_specWith(binding)),
        _throwsFormat(".id' to be a non-empty string"),
      );
    });

    test('a binding with an empty id', () {
      expect(
        () => _build(_specWith(_binding(id: ''))),
        _throwsFormat(".id' to be a non-empty string"),
      );
    });

    test('a binding with a blank kind', () {
      expect(
        () => _build(_specWith(_binding(kind: ''))),
        _throwsFormat(".kind' to be a non-empty string"),
      );
    });

    test('a transferable binding with an unknown abi', () {
      expect(
        () => _build(_specWith(_binding(abi: 'blocks-transferable-v2'))),
        _throwsFormat(
          "Unsupported 'x-blocks-native-bindings.bindings[0].abi': "
          "'blocks-transferable-v2' (expected 'blocks-transferable-v1')",
        ),
      );
    });

    test('a generic arity above one', () {
      expect(
        () => _build(_specWith(_binding(genericArity: 2))),
        _throwsFormat(".genericArity' to be 0 or 1"),
      );
    });

    test('a missing generic arity', () {
      final binding = _binding()..remove('genericArity');
      expect(
        () => _build(_specWith(binding)),
        _throwsFormat(".genericArity' to be 0 or 1"),
      );
    });

    test('two bindings on the same tag', () {
      final spec = _specJson(
        extras: _catalogs(
          bindings: [
            _binding(),
            _binding(export: 'other'),
          ],
        ),
      );
      expect(
        () => _build(spec),
        _throwsFormat("Duplicate binding for tag '$_tag'"),
      );
    });

    test('a binding naming an undeclared package', () {
      expect(
        () => _build(_specWith(_binding(package: 'absent-native'))),
        _throwsFormat("names package 'absent-native'"),
      );
    });

    test('an export that cannot name a public Dart type', () {
      for (final export in const ['_private', '2device', 'device link']) {
        expect(
          () => _build(_specWith(_binding(export: export))),
          _throwsFormat("export '$export' does not name a public Dart type"),
          reason: export,
        );
      }
    });

    test('type-arg count disagreeing with the declared arity', () {
      expect(
        () => _build(
          _specJson(
            resultSchema: const {
              'x-blocks-transferable': _tag,
              'x-blocks-type-args': [_messageSchema],
            },
            extras: _catalogs(),
          ),
        ),
        _throwsFormat('declares 1 x-blocks-type-args'),
      );
    });

    test('an arity-one binding whose result declares no type arg', () {
      expect(
        () => _build(_specWith(_binding(genericArity: 1))),
        _throwsFormat('declares 0 x-blocks-type-args'),
      );
    });
  });
}

List<String> _directives(String output) =>
    output.split('\n').where((line) => line.startsWith('import ')).toList();

/// A spec whose arity-one type-arg `$ref` target is renamed by the collision
/// pass, so the decoder it named no longer exists under that name.
String _renamedPayloadSpec() => jsonEncode({
  'openrpc': '1.3.2',
  'info': {'title': 'test', 'version': '1.0.0'},
  'components': {
    'schemas': {
      'Msg': {
        'type': 'object',
        'properties': {
          'celsius': {'type': 'number'},
        },
        'required': ['celsius'],
      },
    },
  },
  'methods': [
    {
      'name': 'api.connectDevice',
      'params': <Map<String, dynamic>>[],
      'result': {
        'name': 'ConnectDeviceResult',
        'schema': {
          'x-blocks-transferable': _tag,
          'x-blocks-type-args': [
            {r'$ref': '#/components/schemas/Msg'},
          ],
        },
      },
    },
    {
      'name': 'api.kind',
      'params': <Map<String, dynamic>>[],
      'result': {
        'name': 'Msg',
        'schema': {
          'type': 'string',
          'enum': ['a', 'b'],
        },
      },
    },
  ],
  ..._catalogs(bindings: [_binding(genericArity: 1)]),
});

String _patternSpec(String pattern) => jsonEncode({
  'openrpc': '1.3.2',
  'info': {'title': 'test', 'version': '1.0.0'},
  'methods': [
    {
      'name': 'api.connectDevice',
      'params': <Map<String, dynamic>>[],
      'result': {
        'name': 'ConnectDeviceResult',
        'schema': {
          'type': 'object',
          'properties': {
            'label': {'type': 'string', 'pattern': pattern},
          },
          'required': ['label'],
        },
      },
    },
  ],
});

String _namespaceSpec(String name) => jsonEncode({
  'openrpc': '1.3.2',
  'info': {'title': 'test', 'version': '1.0.0'},
  'methods': [
    {
      'name': name,
      'params': <Map<String, dynamic>>[],
      'result': {
        'name': 'R',
        'schema': {'type': 'string'},
      },
    },
  ],
});

/// A spec whose two namespaces differ only by punctuation, so both normalise
/// to one Dart name.
String _collidingNamespaceSpec() => jsonEncode({
  'openrpc': '1.3.2',
  'info': {'title': 'test', 'version': '1.0.0'},
  'methods': [
    {
      'name': 'api.foo.bar',
      'params': <Map<String, dynamic>>[],
      'result': {
        'name': 'BarResult',
        'schema': {'type': 'string'},
      },
    },
    {
      'name': 'apiFoo.baz',
      'params': <Map<String, dynamic>>[],
      'result': {
        'name': 'BazResult',
        'schema': {'type': 'string'},
      },
    },
  ],
});

Matcher _throwsFormat(String needle) => throwsA(
  isA<FormatException>().having((e) => e.message, 'message', contains(needle)),
);

Map<String, dynamic> _dartPackage({
  String name = 'example_iot_native',
  String library = 'example_iot_native.dart',
}) => {
  'package': {'name': name, 'library': library},
};

Map<String, dynamic> _dartPlatform({
  String name = 'example_iot_native',
  String library = 'example_iot_native.dart',
}) => {'dart': _dartPackage(name: name, library: library)};

/// A spec whose bound arity-one result is the second method in its namespace,
/// so a pass that indexed from zero would settle the wrong operation.
String _secondMethodBoundSpec() => jsonEncode({
  'openrpc': '1.3.2',
  'info': {'title': 'test', 'version': '1.0.0'},
  'methods': [
    {
      'name': 'api.plain',
      'params': <Map<String, dynamic>>[],
      'result': {
        'name': 'PlainResult',
        'schema': {
          'type': 'object',
          'properties': {
            'ok': {'type': 'boolean'},
          },
          'required': ['ok'],
        },
      },
    },
    {
      'name': 'api.streamed',
      'params': <Map<String, dynamic>>[],
      'result': {
        'name': 'StreamedResult',
        'schema': {
          'x-blocks-transferable': _tag,
          'x-blocks-type-args': [
            {'type': 'string'},
          ],
        },
      },
    },
  ],
  ..._catalogs(bindings: [_binding(genericArity: 1)]),
});

Map<String, dynamic> _binding({
  String id = 'example-device-link',
  String kind = 'transferable',
  String tag = _tag,
  String package = 'example-iot-native',
  String export = 'deviceLink',
  String abi = 'blocks-transferable-v1',
  int genericArity = 0,
}) => {
  'id': id,
  'kind': kind,
  'tag': tag,
  'package': package,
  'export': export,
  'abi': abi,
  'genericArity': genericArity,
};

Map<String, dynamic> _catalogs({
  Map<String, dynamic>? platforms,
  List<Map<String, dynamic>>? bindings,
  Map<String, dynamic>? packages,
}) => {
  'x-blocks-native-packages': {
    'schemaVersion': 1,
    'packages':
        packages ??
        {
          'example-iot-native': {
            'platforms': platforms ?? {'dart': _dartPackage()},
          },
        },
  },
  'x-blocks-native-bindings': {
    'schemaVersion': 1,
    'bindings': bindings ?? [_binding()],
  },
};

String _specJson({
  Map<String, dynamic> resultSchema = const {'x-blocks-transferable': _tag},
  Map<String, dynamic> extras = const {},
  Map<String, dynamic>? schemas,
  List<Map<String, dynamic>> params = const [],
  String methodName = 'api.connectDevice',
}) => jsonEncode({
  'openrpc': '1.3.2',
  'info': {'title': 'test', 'version': '1.0.0'},
  'methods': [
    {
      'name': methodName,
      'params': params,
      'result': {'name': 'ConnectDeviceResult', 'schema': resultSchema},
    },
  ],
  if (schemas != null) 'components': {'schemas': schemas},
  ...extras,
});

/// A spec whose second method's declared result name synthesizes `Telemetry`,
/// so a bound export resolving to it collides with a generated type.
String _twoMethodSpec(
  Map<String, dynamic> binding, {
  List<Map<String, dynamic>> alsoBind = const [],
}) => jsonEncode({
  'openrpc': '1.3.2',
  'info': {'title': 'test', 'version': '1.0.0'},
  'methods': [
    {
      'name': 'api.connectDevice',
      'params': <Map<String, dynamic>>[],
      'result': {
        'name': 'ConnectDeviceResult',
        'schema': {'x-blocks-transferable': _tag},
      },
    },
    {
      'name': 'api.readTelemetry',
      'params': <Map<String, dynamic>>[],
      'result': {
        'name': 'Telemetry',
        'schema': {
          'type': 'object',
          'properties': {
            'celsius': {'type': 'number'},
          },
          'required': ['celsius'],
        },
      },
    },
  ],
  ..._catalogs(bindings: [binding, ...alsoBind]),
});

/// A spec whose two methods both return a transferable bound to the same
/// declared library, so one directive must carry both shown names. [name]
/// chooses where that directive sorts against the runtime's.
String _twoBoundSpec({String name = 'example_iot_native'}) => jsonEncode({
  'openrpc': '1.3.2',
  'info': {'title': 'test', 'version': '1.0.0'},
  // Stream method first, so an unsorted `show` would read
  // `SensorStream, DeviceLink`.
  'methods': [
    {
      'name': 'api.readStream',
      'params': <Map<String, dynamic>>[],
      'result': {
        'name': 'ReadStreamResult',
        'schema': {'x-blocks-transferable': 'example-iot/sensor-stream'},
      },
    },
    {
      'name': 'api.connectDevice',
      'params': <Map<String, dynamic>>[],
      'result': {
        'name': 'ConnectDeviceResult',
        'schema': {'x-blocks-transferable': _tag},
      },
    },
  ],
  ..._catalogs(
    platforms: _dartPlatform(name: name, library: '$name.dart'),
    bindings: [
      _binding(tag: 'example-iot/sensor-stream', export: 'sensorStream'),
      _binding(),
    ],
  ),
});

String _specWith(Map<String, dynamic> binding) =>
    _specJson(extras: _catalogs(bindings: [binding]));

String _arityOneSpec() => _specJson(
  resultSchema: const {
    'x-blocks-transferable': _tag,
    'x-blocks-type-args': [_messageSchema],
  },
  extras: _catalogs(bindings: [_binding(genericArity: 1)]),
);

/// A spec whose second method's result is a discriminated union, so the
/// generator emits a sealed parent and one class per variant.
String _unionSpec(Map<String, dynamic> binding) => jsonEncode({
  'openrpc': '1.3.2',
  'info': {'title': 'test', 'version': '1.0.0'},
  'methods': [
    {
      'name': 'api.connectDevice',
      'params': <Map<String, dynamic>>[],
      'result': {
        'name': 'ConnectDeviceResult',
        'schema': {'x-blocks-transferable': _tag},
      },
    },
    {
      'name': 'api.doAction',
      'params': <Map<String, dynamic>>[],
      'result': {
        'name': 'ApiDoActionInput',
        'schema': {
          'oneOf': [
            {
              'type': 'object',
              'properties': {
                'kind': {
                  'type': 'string',
                  'enum': ['create'],
                },
                'name': {'type': 'string'},
              },
              'required': ['kind', 'name'],
            },
            {
              'type': 'object',
              'properties': {
                'kind': {
                  'type': 'string',
                  'enum': ['remove'],
                },
                'id': {'type': 'string'},
              },
              'required': ['kind', 'id'],
            },
          ],
        },
      },
    },
  ],
  ..._catalogs(bindings: [binding]),
});

String _generateFrom(String spec) => _generate(_build(spec));

CodegenModel _build(String spec) =>
    CodegenModelBuilder().build(const OpenRpcParser().parse(spec));

String _generate(CodegenModel model) =>
    const DartCodeGenerator().generate(model);
