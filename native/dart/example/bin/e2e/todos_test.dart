import 'harness.dart';

/// Todos E2E — the native-bindings DistributedTable block, exposed as a
/// per-user todo list. Every Todos RPC is auth-gated behind
/// `authBasic.requireAuth(context)`, so the suite signs in first and also
/// verifies the gate rejects unauthenticated callers.
void main() async {
  final blocks = createBlocks();
  final suffix = DateTime.now().millisecondsSinceEpoch.toString();

  group('Todos: auth gate (unauthenticated)');
  // Before signing in, the DistributedTable RPCs must reject the caller.
  await expectError(
    () => blocks.api.listTodos(),
    label: 'listTodos throws when not authenticated',
  );
  await expectError(
    () => blocks.api.createTodo(title: 'should-fail'),
    label: 'createTodo throws when not authenticated',
  );

  group('Todos: sign in');
  final username = 'todouser_$suffix';
  final password = 'pass1234';
  final signUp = await blocks.api.basicSignUp(
    username: username,
    password: password,
  );
  check(signUp.success, 'basicSignUp success');
  final user = await blocks.api.basicSignIn(
    username: username,
    password: password,
  );
  check(user.username == username, 'basicSignIn as $username');

  group('Todos: create');
  final t1 = await blocks.api.createTodo(title: 'first todo', priority: 1);
  check(t1.todoId.isNotEmpty, 'createTodo returns a todoId');
  check(t1.title == 'first todo', 'title matches');
  check(t1.completed == false, 'new todo is not completed');
  check(t1.priority == 1, 'priority matches (got: ${t1.priority})');

  group('Todos: get');
  final got = await blocks.api.getTodo(todoId: t1.todoId);
  check(got != null, 'getTodo returns the todo');
  check(got?.title == 'first todo', 'fetched title matches');

  group('Todos: create more + list');
  final t2 = await blocks.api.createTodo(title: 'second todo', priority: 3);
  final t3 = await blocks.api.createTodo(title: 'third todo', priority: 2);
  final all = await blocks.api.listTodos();
  check(all.length >= 3, 'listTodos returns at least 3 (got: ${all.length})');

  group('Todos: list sorted by priority');
  final byPriority = await blocks.api.listTodos(
    sortBy: ApiListTodosSortBy.priority,
  );
  final priorities = byPriority.map((t) => t.priority).toList();
  final sorted = [...priorities]..sort();
  check(
    priorities.toString() == sorted.toString(),
    'priorities are ascending (got: $priorities)',
  );

  group('Todos: list sorted by createdAt');
  final byCreated = await blocks.api.listTodos(
    sortBy: ApiListTodosSortBy.createdAt,
  );
  check(byCreated.length >= 3, 'createdAt sort returns all todos');

  group('Todos: update');
  final upd = await blocks.api.updateTodo(
    todoId: t1.todoId,
    updates: const ApiUpdateTodoUpdates(
      completed: true,
      title: 'first todo (done)',
    ),
  );
  check(upd.success, 'updateTodo returns success');
  final afterUpdate = await blocks.api.getTodo(todoId: t1.todoId);
  check(afterUpdate?.completed == true, 'todo marked completed');
  check(afterUpdate?.title == 'first todo (done)', 'title updated');

  group('Todos: delete');
  final del = await blocks.api.deleteTodo(todoId: t2.todoId);
  check(del.success, 'deleteTodo returns success');
  final gone = await blocks.api.getTodo(todoId: t2.todoId);
  check(gone == null, 'deleted todo returns null');

  group('Todos: isolation after sign out');
  await blocks.api.basicSignOut();
  await expectError(
    () => blocks.api.listTodos(),
    label: 'listTodos throws again after sign out',
  );

  // Keep t3 referenced so analyzer doesn't flag it as unused.
  check(t3.todoId.isNotEmpty, 'third todo exists (id: ${t3.todoId})');

  printResults();
}
