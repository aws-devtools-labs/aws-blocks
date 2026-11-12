// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// Requires blocks_runtime 0.1.5 or later.
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;
export 'package:blocks_runtime/blocks_runtime.dart' show RealtimeChannel, FileDownloadHandle, FileUploadHandle;

// --- Models ---

sealed class TaskLabels {
  static const red = TaskLabelsKnown.red;
  static const green = TaskLabelsKnown.green;
  static const values = TaskLabelsKnown.values;
  static final Map<String, TaskLabelsKnown> _byJson = TaskLabelsKnown.values.asNameMap();

  String toJson();
  static TaskLabels fromJson(String json) => _byJson[json] ?? TaskLabelsUnknown(json);
}

enum TaskLabelsKnown implements TaskLabels {
  red,
  green
;

  @override
  String toJson() => name;
}

/// A `TaskLabels` value this client was generated without.
final class TaskLabelsUnknown implements TaskLabels {
  /// The value as the server sent it.
  final String value;

  const TaskLabelsUnknown(this.value);

  @override
  String toJson() => value;

  @override
  bool operator ==(Object other) =>
      other is TaskLabelsUnknown && value == other.value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => 'TaskLabelsUnknown' '($value)';
}


sealed class TaskPriority {
  static const low = TaskPriorityKnown.low;
  static const high = TaskPriorityKnown.high;
  static const values = TaskPriorityKnown.values;
  static final Map<String, TaskPriorityKnown> _byJson = TaskPriorityKnown.values.asNameMap();

  String toJson();
  static TaskPriority fromJson(String json) => _byJson[json] ?? TaskPriorityUnknown(json);
}

enum TaskPriorityKnown implements TaskPriority {
  low,
  high
;

  @override
  String toJson() => name;
}

/// A `TaskPriority` value this client was generated without.
final class TaskPriorityUnknown implements TaskPriority {
  /// The value as the server sent it.
  final String value;

  const TaskPriorityUnknown(this.value);

  @override
  String toJson() => value;

  @override
  bool operator ==(Object other) =>
      other is TaskPriorityUnknown && value == other.value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => 'TaskPriorityUnknown' '($value)';
}


sealed class TaskSource {
  static const web = TaskSourceKnown.web;
  static const unknown = TaskSourceKnown.unknown;
  static const values = TaskSourceKnown.values;
  static final Map<String, TaskSourceKnown> _byJson = TaskSourceKnown.values.asNameMap();

  String toJson();
  static TaskSource fromJson(String json) => _byJson[json] ?? TaskSourceUnknown(json);
}

enum TaskSourceKnown implements TaskSource {
  web,
  unknown
;

  @override
  String toJson() => name;
}

/// A `TaskSource` value this client was generated without.
final class TaskSourceUnknown implements TaskSource {
  /// The value as the server sent it.
  final String value;

  const TaskSourceUnknown(this.value);

  @override
  String toJson() => value;

  @override
  bool operator ==(Object other) =>
      other is TaskSourceUnknown && value == other.value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => 'TaskSourceUnknown' '($value)';
}


sealed class TaskPhase {
  static const companion = TaskPhaseKnown.companion;
  static const other = TaskPhaseKnown.other;
  static const values = TaskPhaseKnown.values;
  static final Map<String, TaskPhaseKnown> _byJson = TaskPhaseKnown.values.asNameMap();

  String toJson();
  static TaskPhase fromJson(String json) => _byJson[json] ?? TaskPhaseUnknown(json);
}

enum TaskPhaseKnown implements TaskPhase {
  companion,
  other
;

  @override
  String toJson() => name;
}

/// A `TaskPhase` value this client was generated without.
final class TaskPhaseUnknown implements TaskPhase {
  /// The value as the server sent it.
  final String value;

  const TaskPhaseUnknown(this.value);

  @override
  String toJson() => value;

  @override
  bool operator ==(Object other) =>
      other is TaskPhaseUnknown && value == other.value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => 'TaskPhaseUnknown' '($value)';
}


sealed class NodeKind {
  static const leaf = NodeKindKnown.leaf;
  static const branch = NodeKindKnown.branch;
  static const values = NodeKindKnown.values;
  static final Map<String, NodeKindKnown> _byJson = NodeKindKnown.values.asNameMap();

  String toJson();
  static NodeKind fromJson(String json) => _byJson[json] ?? NodeKindUnknown(json);
}

enum NodeKindKnown implements NodeKind {
  leaf,
  branch
;

  @override
  String toJson() => name;
}

/// A `NodeKind` value this client was generated without.
final class NodeKindUnknown implements NodeKind {
  /// The value as the server sent it.
  final String value;

  const NodeKindUnknown(this.value);

  @override
  String toJson() => value;

  @override
  bool operator ==(Object other) =>
      other is NodeKindUnknown && value == other.value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => 'NodeKindUnknown' '($value)';
}


sealed class Kind {
  static const kind = KindKnown.kind;
  static const other = KindKnown.other;
  static const values = KindKnown.values;
  static final Map<String, KindKnown> _byJson = KindKnown.values.asNameMap();

  String toJson();
  static Kind fromJson(String json) => _byJson[json] ?? KindUnknown(json);
}

enum KindKnown implements Kind {
  kind,
  other
;

  @override
  String toJson() => name;
}

/// A `Kind` value this client was generated without.
final class KindUnknown implements Kind {
  /// The value as the server sent it.
  final String value;

  const KindUnknown(this.value);

  @override
  String toJson() => value;

  @override
  bool operator ==(Object other) =>
      other is KindUnknown && value == other.value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => 'KindUnknown' '($value)';
}


sealed class LabelsSpelling {
  static const unknown = LabelsSpellingKnown.unknown;
  static const unKnown = LabelsSpellingKnown.unKnown;
  static const values = LabelsSpellingKnown.values;

  String toJson();
  static LabelsSpelling fromJson(String json) => LabelsSpellingKnown._jsonMap[json] ?? LabelsSpellingUnknown(json);
}

enum LabelsSpellingKnown implements LabelsSpelling {
  unknown,
  unKnown
;

  static const _jsonMap = <String, LabelsSpellingKnown>{
    'unknown': unknown,
    'un-known': unKnown,
  };
  static const _toJsonMap = <LabelsSpellingKnown, String>{
    unknown: 'unknown',
    unKnown: 'un-known',
  };
  @override
  String toJson() => _toJsonMap[this]!;
}

/// A `LabelsSpelling` value this client was generated without.
final class LabelsSpellingUnknown implements LabelsSpelling {
  /// The value as the server sent it.
  final String value;

  const LabelsSpellingUnknown(this.value);

  @override
  String toJson() => value;

  @override
  bool operator ==(Object other) =>
      other is LabelsSpellingUnknown && value == other.value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => 'LabelsSpellingUnknown' '($value)';
}


sealed class LabelsCase {
  static const fooBar$ = LabelsCaseKnown.fooBar$;
  static const foo_bar = LabelsCaseKnown.foo_bar;
  static const fooBar = LabelsCaseKnown.fooBar;
  static const FOO_BAR = LabelsCaseKnown.FOO_BAR;
  static const fooBar$$ = LabelsCaseKnown.fooBar$$;
  static const values = LabelsCaseKnown.values;

  String toJson();
  static LabelsCase fromJson(String json) => LabelsCaseKnown._jsonMap[json] ?? LabelsCaseUnknown(json);
}

enum LabelsCaseKnown implements LabelsCase {
  fooBar$,
  foo_bar,
  fooBar,
  FOO_BAR,
  fooBar$$
;

  static const _jsonMap = <String, LabelsCaseKnown>{
    'foo-bar': fooBar$,
    'foo_bar': foo_bar,
    'fooBar': fooBar,
    'FOO_BAR': FOO_BAR,
    'foo bar': fooBar$$,
  };
  static const _toJsonMap = <LabelsCaseKnown, String>{
    fooBar$: 'foo-bar',
    foo_bar: 'foo_bar',
    fooBar: 'fooBar',
    FOO_BAR: 'FOO_BAR',
    fooBar$$: 'foo bar',
  };
  @override
  String toJson() => _toJsonMap[this]!;
}

/// A `LabelsCase` value this client was generated without.
final class LabelsCaseUnknown implements LabelsCase {
  /// The value as the server sent it.
  final String value;

  const LabelsCaseUnknown(this.value);

  @override
  String toJson() => value;

  @override
  bool operator ==(Object other) =>
      other is LabelsCaseUnknown && value == other.value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => 'LabelsCaseUnknown' '($value)';
}


sealed class LabelsFallback {
  static const unknown = LabelsFallbackKnown.unknown;
  static const unknownValue = LabelsFallbackKnown.unknownValue;
  static const UnknownValue = LabelsFallbackKnown.UnknownValue;
  static const values = LabelsFallbackKnown.values;
  static final Map<String, LabelsFallbackKnown> _byJson = LabelsFallbackKnown.values.asNameMap();

  String toJson();
  static LabelsFallback fromJson(String json) => _byJson[json] ?? LabelsFallbackUnknown(json);
}

enum LabelsFallbackKnown implements LabelsFallback {
  unknown,
  unknownValue,
  UnknownValue
;

  @override
  String toJson() => name;
}

/// A `LabelsFallback` value this client was generated without.
final class LabelsFallbackUnknown implements LabelsFallback {
  /// The value as the server sent it.
  final String value;

  const LabelsFallbackUnknown(this.value);

  @override
  String toJson() => value;

  @override
  bool operator ==(Object other) =>
      other is LabelsFallbackUnknown && value == other.value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => 'LabelsFallbackUnknown' '($value)';
}


sealed class LabelsMaybe {
  static const yes = LabelsMaybeKnown.yes;
  static const no = LabelsMaybeKnown.no;
  static const values = LabelsMaybeKnown.values;
  static final Map<String, LabelsMaybeKnown> _byJson = LabelsMaybeKnown.values.asNameMap();

  String toJson();
  static LabelsMaybe fromJson(String json) => _byJson[json] ?? LabelsMaybeUnknown(json);
}

enum LabelsMaybeKnown implements LabelsMaybe {
  yes,
  no
;

  @override
  String toJson() => name;
}

/// A `LabelsMaybe` value this client was generated without.
final class LabelsMaybeUnknown implements LabelsMaybe {
  /// The value as the server sent it.
  final String value;

  const LabelsMaybeUnknown(this.value);

  @override
  String toJson() => value;

  @override
  bool operator ==(Object other) =>
      other is LabelsMaybeUnknown && value == other.value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => 'LabelsMaybeUnknown' '($value)';
}


sealed class FlaggedGetEventResultSeverity {
  static const low = FlaggedGetEventResultSeverityKnown.low;
  static const high = FlaggedGetEventResultSeverityKnown.high;
  static const values = FlaggedGetEventResultSeverityKnown.values;
  static final Map<String, FlaggedGetEventResultSeverityKnown> _byJson = FlaggedGetEventResultSeverityKnown.values.asNameMap();

  String toJson();
  static FlaggedGetEventResultSeverity fromJson(String json) => _byJson[json] ?? FlaggedGetEventResultSeverityUnknown(json);
}

enum FlaggedGetEventResultSeverityKnown implements FlaggedGetEventResultSeverity {
  low,
  high
;

  @override
  String toJson() => name;
}

/// A `FlaggedGetEventResultSeverity` value this client was generated without.
final class FlaggedGetEventResultSeverityUnknown implements FlaggedGetEventResultSeverity {
  /// The value as the server sent it.
  final String value;

  const FlaggedGetEventResultSeverityUnknown(this.value);

  @override
  String toJson() => value;

  @override
  bool operator ==(Object other) =>
      other is FlaggedGetEventResultSeverityUnknown && value == other.value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => 'FlaggedGetEventResultSeverityUnknown' '($value)';
}


sealed class WatchTasksResultMessageChange {
  static const created = WatchTasksResultMessageChangeKnown.created;
  static const deleted = WatchTasksResultMessageChangeKnown.deleted;
  static const values = WatchTasksResultMessageChangeKnown.values;
  static final Map<String, WatchTasksResultMessageChangeKnown> _byJson = WatchTasksResultMessageChangeKnown.values.asNameMap();

  String toJson();
  static WatchTasksResultMessageChange fromJson(String json) => _byJson[json] ?? WatchTasksResultMessageChangeUnknown(json);
}

enum WatchTasksResultMessageChangeKnown implements WatchTasksResultMessageChange {
  created,
  deleted
;

  @override
  String toJson() => name;
}

/// A `WatchTasksResultMessageChange` value this client was generated without.
final class WatchTasksResultMessageChangeUnknown implements WatchTasksResultMessageChange {
  /// The value as the server sent it.
  final String value;

  const WatchTasksResultMessageChangeUnknown(this.value);

  @override
  String toJson() => value;

  @override
  bool operator ==(Object other) =>
      other is WatchTasksResultMessageChangeUnknown && value == other.value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => 'WatchTasksResultMessageChangeUnknown' '($value)';
}


class WatchTasksResultMessage {
  final String taskId;
  final WatchTasksResultMessageChange change;

  const WatchTasksResultMessage({
    required this.taskId,
    required this.change,
  });

  factory WatchTasksResultMessage.fromJson(Map<String, dynamic> json) {
    return WatchTasksResultMessage(
      taskId: json['taskId'] as String,
      change: WatchTasksResultMessageChange.fromJson(json['change'] as String),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'taskId': taskId,
      'change': change.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is WatchTasksResultMessage &&
          taskId == other.taskId &&
          change == other.change;

  @override
  int get hashCode => Object.hash(taskId, change);

  @override
  String toString() => 'WatchTasksResultMessage(taskId: $taskId, change: $change)';
}


sealed class GetSettingsResultMode {
  static const light = GetSettingsResultModeKnown.light;
  static const dark = GetSettingsResultModeKnown.dark;
  static const values = GetSettingsResultModeKnown.values;
  static final Map<String, GetSettingsResultModeKnown> _byJson = GetSettingsResultModeKnown.values.asNameMap();

  String toJson();
  static GetSettingsResultMode fromJson(String json) => _byJson[json] ?? GetSettingsResultModeUnknown(json);
}

enum GetSettingsResultModeKnown implements GetSettingsResultMode {
  light,
  dark
;

  @override
  String toJson() => name;
}

/// A `GetSettingsResultMode` value this client was generated without.
final class GetSettingsResultModeUnknown implements GetSettingsResultMode {
  /// The value as the server sent it.
  final String value;

  const GetSettingsResultModeUnknown(this.value);

  @override
  String toJson() => value;

  @override
  bool operator ==(Object other) =>
      other is GetSettingsResultModeUnknown && value == other.value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => 'GetSettingsResultModeUnknown' '($value)';
}


// --- API Namespaces ---

sealed class Status {
  static const todo = StatusKnown.todo;
  static const inProgress = StatusKnown.inProgress;
  static const done = StatusKnown.done;
  static const values = StatusKnown.values;

  String toJson();
  static Status fromJson(String json) => StatusKnown._jsonMap[json] ?? StatusUnknown(json);
}

enum StatusKnown implements Status {
  todo,
  inProgress,
  done
;

  static const _jsonMap = <String, StatusKnown>{
    'todo': todo,
    'in-progress': inProgress,
    'done': done,
  };
  static const _toJsonMap = <StatusKnown, String>{
    todo: 'todo',
    inProgress: 'in-progress',
    done: 'done',
  };
  @override
  String toJson() => _toJsonMap[this]!;
}

/// A `Status` value this client was generated without.
final class StatusUnknown implements Status {
  /// The value as the server sent it.
  final String value;

  const StatusUnknown(this.value);

  @override
  String toJson() => value;

  @override
  bool operator ==(Object other) =>
      other is StatusUnknown && value == other.value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => 'StatusUnknown' '($value)';
}


class Task {
  final String id;
  final Status status;
  final List<Status> history;
  final Map<String, TaskLabels> labels;
  final TaskPriority? priority;
  final TaskSource? source;
  final TaskPhase? phase;

  const Task({
    required this.id,
    required this.status,
    required this.history,
    required this.labels,
    this.priority,
    this.source,
    this.phase,
  });

  factory Task.fromJson(Map<String, dynamic> json) {
    return Task(
      id: json['id'] as String,
      status: Status.fromJson(json['status'] as String),
      history: (json['history'] as List<dynamic>).map((e) => Status.fromJson(e as String)).toList(),
      labels: (json['labels'] as Map<String, dynamic>).map((k, v) => MapEntry(k, TaskLabels.fromJson(v as String))),
      priority: json['priority'] != null ? TaskPriority.fromJson(json['priority'] as String) : null,
      source: json['source'] != null ? TaskSource.fromJson(json['source'] as String) : null,
      phase: json['phase'] != null ? TaskPhase.fromJson(json['phase'] as String) : null,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'status': status.toJson(),
      'history': history.map((e) => e.toJson()).toList(),
      'labels': labels.map((k, v) => MapEntry(k, v.toJson())),
      if (priority != null) 'priority': priority?.toJson(),
      if (source != null) 'source': source?.toJson(),
      if (phase != null) 'phase': phase?.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Task &&
          id == other.id &&
          status == other.status &&
          blocksDeepEquals(history, other.history) &&
          blocksDeepEquals(labels, other.labels) &&
          priority == other.priority &&
          source == other.source &&
          phase == other.phase;

  @override
  int get hashCode => Object.hash(id, status, blocksDeepHash(history), blocksDeepHash(labels), priority, source, phase);

  @override
  String toString() => 'Task(id: $id, status: $status, history: $history, labels: $labels, priority: $priority, source: $source, phase: $phase)';
}


sealed class Color {
  static const red = ColorKnown.red;
  static const blue = ColorKnown.blue;
  static const values = ColorKnown.values;
  static final Map<String, ColorKnown> _byJson = ColorKnown.values.asNameMap();

  String toJson();
  static Color fromJson(String json) => _byJson[json] ?? ColorUnknown(json);
}

enum ColorKnown implements Color {
  red,
  blue
;

  @override
  String toJson() => name;
}

/// A `Color` value this client was generated without.
final class ColorUnknown implements Color {
  /// The value as the server sent it.
  final String value;

  const ColorUnknown(this.value);

  @override
  String toJson() => value;

  @override
  bool operator ==(Object other) =>
      other is ColorUnknown && value == other.value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => 'ColorUnknown' '($value)';
}


sealed class Size {
  static const small = SizeKnown.small;
  static const large = SizeKnown.large;
  static const values = SizeKnown.values;
  static final Map<String, SizeKnown> _byJson = SizeKnown.values.asNameMap();

  String toJson();
  static Size fromJson(String json) => _byJson[json] ?? SizeUnknown(json);
}

enum SizeKnown implements Size {
  small,
  large
;

  @override
  String toJson() => name;
}

/// A `Size` value this client was generated without.
final class SizeUnknown implements Size {
  /// The value as the server sent it.
  final String value;

  const SizeUnknown(this.value);

  @override
  String toJson() => value;

  @override
  bool operator ==(Object other) =>
      other is SizeUnknown && value == other.value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => 'SizeUnknown' '($value)';
}


enum Mode {
  auto,
  manual
;

  String toJson() => name;
  static Mode fromJson(String json) => values.byName(json);
}


class Node {
  final NodeKind kind;
  final List<Node> children;

  const Node({
    required this.kind,
    required this.children,
  });

  factory Node.fromJson(Map<String, dynamic> json) {
    return Node(
      kind: NodeKind.fromJson(json['kind'] as String),
      children: (json['children'] as List<dynamic>).map((e) => Node.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'kind': kind.toJson(),
      'children': children.map((e) => e.toJson()).toList(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Node &&
          kind == other.kind &&
          blocksDeepEquals(children, other.children);

  @override
  int get hashCode => Object.hash(kind, blocksDeepHash(children));

  @override
  String toString() => 'Node(kind: $kind, children: $children)';
}


class Labels {
  final Kind kind;
  final LabelsSpelling spelling;
  final LabelsCase case$;
  final LabelsFallback fallback;
  final LabelsMaybe? maybe;

  const Labels({
    required this.kind,
    required this.spelling,
    required this.case$,
    required this.fallback,
    required this.maybe,
  });

  factory Labels.fromJson(Map<String, dynamic> json) {
    return Labels(
      kind: Kind.fromJson(json['kind'] as String),
      spelling: LabelsSpelling.fromJson(json['spelling'] as String),
      case$: LabelsCase.fromJson(json['case'] as String),
      fallback: LabelsFallback.fromJson(json['fallback'] as String),
      maybe: json['maybe'] != null ? LabelsMaybe.fromJson(json['maybe'] as String) : null,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'kind': kind.toJson(),
      'spelling': spelling.toJson(),
      'case': case$.toJson(),
      'fallback': fallback.toJson(),
      'maybe': maybe?.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Labels &&
          kind == other.kind &&
          spelling == other.spelling &&
          case$ == other.case$ &&
          fallback == other.fallback &&
          maybe == other.maybe;

  @override
  int get hashCode => Object.hash(kind, spelling, case$, fallback, maybe);

  @override
  String toString() => 'Labels(kind: $kind, spelling: $spelling, case\$: ${case$}, fallback: $fallback, maybe: $maybe)';
}


enum ApiUpdateTaskSort {
  newest,
  oldest
;

  String toJson() => name;
  static ApiUpdateTaskSort fromJson(String json) => values.byName(json);
}


class UpdateTaskResult {
  final bool ok;

  const UpdateTaskResult({
    required this.ok,
  });

  factory UpdateTaskResult.fromJson(Map<String, dynamic> json) {
    return UpdateTaskResult(
      ok: json['ok'] as bool,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'ok': ok,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is UpdateTaskResult &&
          ok == other.ok;

  @override
  int get hashCode => ok.hashCode;

  @override
  String toString() => 'UpdateTaskResult(ok: $ok)';
}


sealed class GetEventResult {
  const GetEventResult();
  Map<String, dynamic> toJson();
  static GetEventResult fromJson(Map<String, dynamic> json) {
    switch (json['kind'] as String) {
      case 'moved': return MovedGetEventResult.fromJson(json);
      case 'flagged': return FlaggedGetEventResult.fromJson(json);
      default: return UnknownGetEventResult(json);
    }
  }
}

class MovedGetEventResult extends GetEventResult {
  final Status to;

  const MovedGetEventResult({
    required this.to,
  });

  factory MovedGetEventResult.fromJson(Map<String, dynamic> json) {
    return MovedGetEventResult(
      to: Status.fromJson(json['to'] as String),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'kind': 'moved',
      'to': to.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MovedGetEventResult &&
          to == other.to;

  @override
  int get hashCode => to.hashCode;

  @override
  String toString() => 'MovedGetEventResult(to: $to)';
}

class FlaggedGetEventResult extends GetEventResult {
  final FlaggedGetEventResultSeverity severity;

  const FlaggedGetEventResult({
    required this.severity,
  });

  factory FlaggedGetEventResult.fromJson(Map<String, dynamic> json) {
    return FlaggedGetEventResult(
      severity: FlaggedGetEventResultSeverity.fromJson(json['severity'] as String),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'kind': 'flagged',
      'severity': severity.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is FlaggedGetEventResult &&
          severity == other.severity;

  @override
  int get hashCode => severity.hashCode;

  @override
  String toString() => 'FlaggedGetEventResult(severity: $severity)';
}

/// A `GetEventResult` arm this client was generated without.
final class UnknownGetEventResult extends GetEventResult {
  /// The object as the server sent it.
  final Map<String, dynamic> json;

  const UnknownGetEventResult(this.json);

  /// The discriminator value that names no known arm.
  String get discriminator => json['kind'] as String;

  @override
  Map<String, dynamic> toJson() => json;

  @override
  bool operator ==(Object other) =>
      other is UnknownGetEventResult && blocksDeepEquals(json, other.json);

  @override
  int get hashCode => blocksDeepHash(json);

  @override
  String toString() => 'UnknownGetEventResult' '($json)';
}



class GetSettingsResult {
  final GetSettingsResultMode mode;

  const GetSettingsResult({
    required this.mode,
  });

  factory GetSettingsResult.fromJson(Map<String, dynamic> json) {
    return GetSettingsResult(
      mode: GetSettingsResultMode.fromJson(json['mode'] as String),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'mode': mode.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is GetSettingsResult &&
          mode == other.mode;

  @override
  int get hashCode => mode.hashCode;

  @override
  String toString() => 'GetSettingsResult(mode: $mode)';
}


sealed class GetRangeResult {
  static const up = GetRangeResultKnown.up;
  static const down = GetRangeResultKnown.down;
  static const values = GetRangeResultKnown.values;
  static final Map<String, GetRangeResultKnown> _byJson = GetRangeResultKnown.values.asNameMap();

  String toJson();
  static GetRangeResult fromJson(String json) => _byJson[json] ?? GetRangeResultUnknown(json);
}

enum GetRangeResultKnown implements GetRangeResult {
  up,
  down
;

  @override
  String toJson() => name;
}

/// A `GetRangeResult` value this client was generated without.
final class GetRangeResultUnknown implements GetRangeResult {
  /// The value as the server sent it.
  final String value;

  const GetRangeResultUnknown(this.value);

  @override
  String toJson() => value;

  @override
  bool operator ==(Object other) =>
      other is GetRangeResultUnknown && value == other.value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => 'GetRangeResultUnknown' '($value)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<Task> getTask({required String id}) async {
    final params = <dynamic>[
      id,
    ];
    final result = await _client.call('api.getTask', params);
    return Task.fromJson(result as Map<String, dynamic>);
  }

  Future<UpdateTaskResult> updateTask({required String id, required Status status, ApiUpdateTaskSort? sort}) async {
    final params = <dynamic>[
      id,
      status.toJson(),
      if (sort != null) sort.toJson(),
    ];
    final result = await _client.call('api.updateTask', params);
    return UpdateTaskResult.fromJson(result as Map<String, dynamic>);
  }

  Future<GetEventResult> getEvent() async {
    final result = await _client.call('api.getEvent', const <dynamic>[]);
    return GetEventResult.fromJson(result as Map<String, dynamic>);
  }

  Future<RealtimeChannel<WatchTasksResultMessage>> watchTasks() async {
    final result = await _client.call('api.watchTasks', const <dynamic>[]);
    return RealtimeChannel.fromJson(result as Map<String, dynamic>, (json) => WatchTasksResultMessage.fromJson(json));
  }

  Future<Color> getColor() async {
    final result = await _client.call('api.getColor', const <dynamic>[]);
    return Color.fromJson(result as String);
  }

  Future<dynamic> getSwatch() async {
    final result = await _client.call('api.getSwatch', const <dynamic>[]);
    return result as dynamic;
  }

  Future<bool> setMode({required Mode mode}) async {
    final params = <dynamic>[
      mode.toJson(),
    ];
    final result = await _client.call('api.setMode', params);
    return result as bool;
  }

  Future<GetSettingsResult> getSettings() async {
    final result = await _client.call('api.getSettings', const <dynamic>[]);
    return GetSettingsResult.fromJson(result as Map<String, dynamic>);
  }

  Future<Node> getTree() async {
    final result = await _client.call('api.getTree', const <dynamic>[]);
    return Node.fromJson(result as Map<String, dynamic>);
  }

  Future<(Size, GetRangeResult)> getRange() async {
    final result = await _client.call('api.getRange', const <dynamic>[]);
    return (Size.fromJson((result as List<dynamic>)[0] as String), GetRangeResult.fromJson((result as List<dynamic>)[1] as String));
  }

  Future<Labels> getLabels() async {
    final result = await _client.call('api.getLabels', const <dynamic>[]);
    return Labels.fromJson(result as Map<String, dynamic>);
  }
}


// --- Blocks Client ---

class Blocks {
  late final ApiApi api;

  Blocks({required String baseUrl, SessionStore? sessionStore}) {
    final client = BlocksClient(baseUrl: baseUrl, sessionStore: sessionStore);
    api = ApiApi(client);
  }
}

