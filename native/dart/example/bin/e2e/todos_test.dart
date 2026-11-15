import 'harness.dart';

/// Todos E2E — the native-bindings DistributedTable block, exposed as a
/// per-user todo list. Every Todos RPC is auth-gated behind the email +
/// password `Auth` block's `requireAuth(context)`, so the suite signs in first
/// and also verifies the gate rejects unauthenticated callers.
void main() async {
  final blocks = createBlocks();

  group('Todos: auth gate (unauthenticated)');
  // Before signing in, the DistributedTable RPCs must reject the caller.
  await expectErrorNamed(
    () => blocks.api.listTodos(),
    AuthErrorNames.notAuthenticated,
    label: 'listTodos throws when not authenticated',
  );
  await expectErrorNamed(
    () => blocks.api.createTodo(title: 'should-fail'),
    AuthErrorNames.notAuthenticated,
    label: 'createTodo throws when not authenticated',
  );

  group('Todos: sign in');
  final user = await signInTestUser(blocks, 'todouser');
  final me = await blocks.api.basicRequireAuth();
  check(me.username == user.username, 'signed in as ${user.username}');

  group('Todos: create');
  final t1 = await blocks.api.createTodo(title: 'first todo', priority: 1);
  check(t1.todoId.isNotEmpty, 'createTodo returns a todoId');
  check(t1.title == 'first todo', 'title matches');
  check(t1.completed == false, 'new todo is not completed');
  check(t1.priority == 1, 'priority matches (got: ${t1.priority})');
  check(
    t1.userSub == me.userSub,
    'todo is keyed on the signed-in user\'s userSub (got: ${t1.userSub})',
  );

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

  group('Todos: another user can neither see nor change them');
  if (isLocalEndpoint()) {
    // A second client has its own cookie session, so this is a second user.
    final other = createBlocks();
    await signInTestUser(other, 'todoother');
    final mine = {t1.todoId, t3.todoId};
    for (final sortBy in <ApiListTodosSortBy?>[
      null,
      ApiListTodosSortBy.priority,
      ApiListTodosSortBy.createdAt,
    ]) {
      final theirs = await other.api.listTodos(sortBy: sortBy);
      check(
        !theirs.any((t) => mine.contains(t.todoId)),
        'the other user\'s list (sortBy: ${sortBy?.name ?? 'none'}) has none of ours',
      );
    }
    check(
      await other.api.getTodo(todoId: t1.todoId) == null,
      'the other user gets null for our todo id',
    );
    var updateRejected = false;
    try {
      await other.api.updateTodo(
        todoId: t1.todoId,
        updates: const ApiUpdateTodoUpdates(title: 'not yours'),
      );
    } catch (_) {
      updateRejected = true;
    }
    check(updateRejected, 'the other user cannot update our todo');
    await other.api.deleteTodo(todoId: t3.todoId);
    final stillThere = await blocks.api.getTodo(todoId: t3.todoId);
    check(
      stillThere != null,
      'the other user\'s delete leaves our todo in place',
    );
    final ours = await blocks.api.getTodo(todoId: t1.todoId);
    check(ours?.title == 'first todo (done)', 'our todo is unchanged');
  } else {
    skip(
      'needs a second freshly signed-up user, which only the local dev server '
      'can confirm (one seeded user exists on a deployed backend)',
    );
  }

  group('Todos: isolation after sign out');
  await blocks.api.basicSignOut();
  await expectErrorNamed(
    () => blocks.api.listTodos(),
    AuthErrorNames.notAuthenticated,
    label: 'listTodos throws again after sign out',
  );

  // Keep t3 referenced so analyzer doesn't flag it as unused.
  check(t3.todoId.isNotEmpty, 'third todo exists (id: ${t3.todoId})');

  printResults();
}
