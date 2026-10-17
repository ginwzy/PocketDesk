import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocketdesk/data/chat.dart';
import 'package:pocketdesk/data/models.dart';
import 'package:pocketdesk/data/tool_presentation.dart';
import 'package:pocketdesk/ui/chat/tool_activity.dart';
import 'package:pocketdesk/ui/pages/chat_page.dart';

import 'harness.dart';

const patch =
    '*** Begin Patch\n*** Update File: /work/demo/src/completion.rs\n@@\n-old_value\n+new_value\n*** Add File: /work/demo/src/bridge.rs\n+new_bridge\n*** End Patch';

void main() {
  setUpAll(loadFonts);

  test('工具参数保留附加字段，单文本字段仍可直接阅读', () {
    ToolPresentation describe(Map<String, dynamic> input) => ToolPresentation(
      ToolItem(
        1,
        1,
        id: 'tool',
        name: 'tool',
        kind: 'command',
        summary: 'tool',
        input: input,
      ),
    );
    for (final input in <Map<String, dynamic>>[
      {
        'command': 'pwd',
        'workdir': '/work/project',
        'timeout': 120,
        'env': {'MODE': 'test'},
      },
      {'cmd': 'pwd', 'timeout': 0},
      {'script': 'echo ok', 'cwd': '/work/project', 'background': false},
      {'input': patch, 'dryRun': true},
    ]) {
      expect(jsonDecode(describe(input).params), input);
    }
    for (final key in ['command', 'cmd', 'script', 'input']) {
      expect(describe({key: 'echo ok'}).params, 'echo ok');
    }
    expect(describe({}).params, isEmpty);
  });

  for (final (size, scale, theme) in [
    (const Size(390, 844), 1.0, ThemeMode.light),
    (const Size(320, 568), 1.3, ThemeMode.dark),
  ]) {
    testWidgets('工具组、补丁详情、原始参数及实时输出（${theme.name}）', (tester) async {
      setSize(tester, size, textScale: scale);
      final env = (await tester.runAsync(() => UiEnv.create(theme: theme)))!;
      final updates = ChangeNotifier();
      final edit = ToolItem(
        1,
        1,
        id: 'patch',
        name: 'apply_patch',
        kind: 'edit',
        summary: 'apply_patch',
        input: {'input': patch},
      )..done = true;
      final short = ToolItem(
        3,
        1,
        id: 'fmt',
        name: 'bash',
        kind: 'command',
        summary: 'cargo fmt --all',
        input: {'command': 'cargo fmt --all'},
      )..done = true;
      final failed =
          ToolItem(
              5,
              1,
              id: 'check',
              name: 'bash',
              kind: 'command',
              summary: 'cargo check',
              input: {'command': 'cargo check'},
            )
            ..done = true
            ..isError = true
            ..output = 'error: missing dependency\nSecond line';
      await tester.pumpWidget(
        pageHost(
          env,
          Scaffold(
            body: SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: ToolActivity(
                  tools: [edit, short, failed],
                  root: '/work/demo',
                  updates: updates,
                ),
              ),
            ),
          ),
        ),
      );
      await settle(tester);
      expect(find.text('src/completion.rs、src/bridge.rs'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await shot(tester, 'tools-${theme.name}-group');

      // 折叠后仍可直接看到失败项和错误首行。
      await tester.tap(find.text('执行过程'));
      await tester.pump();
      expect(find.text('cargo check'), findsOneWidget);
      expect(find.text('error: missing dependency'), findsOneWidget);
      expect(find.text('cargo fmt --all'), findsNothing);
      await tester.tap(find.text('执行过程'));
      await tester.pump();
      await tester.tap(find.text('修改文件'));
      await settle(tester);
      expect(find.byType(ToolDetailPage), findsOneWidget);
      expect(find.text('src/completion.rs'), findsOneWidget);
      expect(
        find.textContaining('new_value', findRichText: true),
        findsOneWidget,
      );
      expect(find.textContaining('*** Begin Patch'), findsNothing);
      await shot(tester, 'tools-${theme.name}-patch');
      await tester.tap(find.text('参数'));
      await tester.pump();
      expect(find.text(patch), findsOneWidget);
      await tester.tap(find.text('原始数据'));
      await tester.pump();
      expect(find.textContaining(r'\n'), findsOneWidget);
      await tester.tap(find.text('结果'));
      await tester.pump();
      edit.output = 'Files successfully updated';
      updates.notifyListeners();
      await tester.pump();
      expect(find.text('Files successfully updated'), findsOneWidget);
      expect(tester.takeException(), isNull);
      Navigator.of(tester.element(find.byType(ToolDetailPage))).pop();
      await settle(tester);
      await tester.tap(find.text('cargo fmt --all'));
      await tester.pump();
      expect(find.text('工具已完成，没有文本输出'), findsOneWidget);
      expect(find.byType(ToolDetailPage), findsNothing);
      await tester.pumpWidget(const SizedBox.shrink());
      updates.dispose();
      await tester.runAsync(env.dispose);
    });
  }

  testWidgets('打开的工具详情在记录重载后更新结果、参数与复制，记录缺失时停止展示', (tester) async {
    setSize(tester, const Size(390, 844));
    const input = {
      'command': 'pwd',
      'workdir': '/work/project',
      'timeout': 120,
    };
    final env = (await tester.runAsync(
      () => UiEnv.create(
        setup: (server) {
          server.sessions.first['lastSeq'] = 1;
          server.events['cc'] = [
            {
              'seq': 1,
              'type': 'tool.start',
              'data': {
                'id': 'tool',
                'name': 'bash',
                'kind': 'command',
                'input': input,
              },
            },
          ];
        },
      ),
    ))!;
    await tester.pumpWidget(pageHost(env, const ChatPage(sessionId: 'cc')));
    await settle(tester, 24);
    await tester.tap(find.text('pwd'));
    await tester.pump();
    await tester.tap(find.text('查看详情'));
    await settle(tester);
    expect(find.text('等待工具返回结果…'), findsOneWidget);
    await tester.tap(find.text('参数'));
    await tester.pump();
    expect(
      find.text(const JsonEncoder.withIndent('  ').convert(input)),
      findsOneWidget,
    );

    final store = env.app.scope!.sessions;
    final log = store.loadedLog('cc')!;
    final old = log.items.single;
    const latestInput = {
      'command': 'pwd',
      'workdir': '/work/project',
      'timeout': 180,
    };
    log.reset([
      const PdEvent(
        session: 'cc',
        seq: 1,
        type: 'tool.start',
        data: {
          'id': 'tool',
          'name': 'bash',
          'kind': 'command',
          'input': latestInput,
        },
      ),
      const PdEvent(
        session: 'cc',
        seq: 2,
        type: 'tool.end',
        data: {'id': 'tool', 'output': '重载后的失败结果', 'isError': true},
      ),
    ]);
    expect(identical(old, log.items.single), isFalse);
    store.onEvent(
      const PdEvent(
        session: 'cc',
        seq: 3,
        type: 'state',
        data: {'state': 'idle'},
      ),
    );
    await tester.pump();
    expect(
      find.text(const JsonEncoder.withIndent('  ').convert(latestInput)),
      findsOneWidget,
    );
    expect(find.text('执行失败'), findsOneWidget);
    await tester.tap(find.text('结果'));
    await tester.pump();
    expect(find.text('重载后的失败结果'), findsOneWidget);
    expect(find.text('等待工具返回结果…'), findsNothing);

    String? copied;
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') {
        copied = (call.arguments as Map)['text'] as String;
      }
      return null;
    });
    addTearDown(
      () => messenger.setMockMethodCallHandler(SystemChannels.platform, null),
    );
    await tester.tap(find.bySemanticsLabel('复制当前内容'));
    await tester.pump();
    expect(copied, '重载后的失败结果');
    await tester.tap(find.text('原始数据'));
    await tester.pump();
    expect(find.textContaining('"isError": true'), findsOneWidget);

    log.reset([]);
    store.onEvent(
      const PdEvent(
        session: 'cc',
        seq: 4,
        type: 'state',
        data: {'state': 'idle'},
      ),
    );
    await tester.pump();
    expect(find.text('暂时无法显示这项操作，请返回聊天重新查看。'), findsOneWidget);
    expect(find.text('重载后的失败结果'), findsNothing);
    expect(find.bySemanticsLabel('复制当前内容'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.runAsync(env.dispose);
  });

  testWidgets('真实聊天列表合并连续工具，并在审批和解释文字处断开', (tester) async {
    setSize(tester, const Size(390, 844));
    final env = (await tester.runAsync(
      () => UiEnv.create(
        setup: (server) {
          server.events['cc'] = [
            {
              'seq': 1,
              'type': 'msg.user',
              'data': {'text': '检查代码'},
            },
            for (final i in [2, 4]) ...[
              {
                'seq': i,
                'type': 'tool.start',
                'data': {
                  'id': 't$i',
                  'name': 'bash',
                  'kind': 'command',
                  'input': {'command': 'echo $i'},
                },
              },
              {
                'seq': i + 1,
                'type': 'tool.end',
                'data': {'id': 't$i', 'output': 'OK'},
              },
            ],
            {
              'seq': 6,
              'type': 'approval.request',
              'data': {
                'id': 'approval',
                'tool': 'bash',
                'kind': 'command',
                'input': {'command': 'pwd'},
              },
            },
            {
              'seq': 7,
              'type': 'msg.done',
              'data': {'id': 'explanation', 'text': '继续检查'},
            },
            {
              'seq': 8,
              'type': 'tool.start',
              'data': {
                'id': 'last',
                'name': 'read',
                'kind': 'read',
                'input': {'path': '/work/demo/file.txt'},
              },
            },
            {
              'seq': 9,
              'type': 'tool.end',
              'data': {'id': 'last', 'output': 'file content'},
            },
          ];
        },
      ),
    ))!;
    await tester.pumpWidget(pageHost(env, const ChatPage(sessionId: 'cc')));
    await settle(tester, 24);
    final groups =
        tester.widgetList<ToolActivity>(find.byType(ToolActivity)).toList()
          ..sort((a, b) => a.tools.first.seq.compareTo(b.tools.first.seq));
    expect(groups.map((g) => g.tools.length), [2, 1]);
    expect(find.text('需要执行命令'), findsOneWidget);
    expect(find.textContaining('继续检查', findRichText: true), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.runAsync(env.dispose);
  });
}
