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

  const Task({
    required this.id,
    required this.status,
    required this.history,
    required this.labels,
    this.priority,
    this.source,
  });

  factory Task.fromJson(Map<String, dynamic> json) {
    return Task(
      id: json['id'] as String,
      status: Status.fromJson(json['status'] as String),
      history: (json['history'] as List<dynamic>).map((e) => Status.fromJson(e as String)).toList(),
      labels: (json['labels'] as Map<String, dynamic>).map((k, v) => MapEntry(k, TaskLabels.fromJson(v as String))),
      priority: json['priority'] != null ? TaskPriority.fromJson(json['priority'] as String) : null,
      source: json['source'] != null ? TaskSource.fromJson(json['source'] as String) : null,
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
          source == other.source;

  @override
  int get hashCode => Object.hash(id, status, blocksDeepHash(history), blocksDeepHash(labels), priority, source);

  @override
  String toString() => 'Task(id: $id, status: $status, history: $history, labels: $labels, priority: $priority, source: $source)';
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
      default: throw ArgumentError('Unknown kind: ${json['kind']}');
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
}


// --- Blocks Client ---

class Blocks {
  late final ApiApi api;

  Blocks({required String baseUrl, SessionStore? sessionStore}) {
    final client = BlocksClient(baseUrl: baseUrl, sessionStore: sessionStore);
    api = ApiApi(client);
  }
}

