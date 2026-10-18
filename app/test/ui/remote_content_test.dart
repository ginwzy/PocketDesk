import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocketdesk/net/api.dart';
import 'package:pocketdesk/ui/remote_content.dart';

void main() {
  testWidgets('选项请求先展示面板，选择时原位等待并阻止重复提交', (tester) async {
    final list = Completer<List<RemoteChoice>>();
    final update = Completer<void>();
    var loads = 0, writes = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => remoteChoiceSheet(
                context,
                title: '切换模型',
                message: '正在获取模型列表…',
                load: () {
                  loads++;
                  return list.future;
                },
              ),
              child: const Text('打开'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('打开'));
    await tester.pump();
    expect(find.text('切换模型'), findsOneWidget);
    list.complete([
      RemoteChoice(
        '模型 A',
        select: () {
          writes++;
          return update.future;
        },
      ),
    ]);
    await tester.pumpAndSettle();
    await tester.tap(find.text('模型 A'));
    await tester.pump();
    expect(find.text('正在切换…'), findsOneWidget);
    expect(find.byType(RemoteSpinner), findsOneWidget);
    await tester.tap(find.text('模型 A'));
    await tester.pump();
    await tester.binding.handlePopRoute();
    await tester.pump();
    expect(find.text('切换模型'), findsOneWidget);
    expect(writes, 1);
    expect(loads, 1);
    update.complete();
    await tester.pumpAndSettle();
    expect(find.text('切换模型'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('确认操作等待响应，失败后在同一对话框重试', (tester) async {
    var request = Completer<void>();
    var writes = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => showDialog<bool>(
                context: context,
                barrierDismissible: false,
                builder: (_) => RemoteConfirmation(
                  title: '切换历史',
                  content: const Text('原路线保留'),
                  confirm: '确认',
                  run: () {
                    writes++;
                    return request.future;
                  },
                ),
              ),
              child: const Text('打开'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('打开'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('确认'));
    await tester.pump();
    expect(find.text('正在切换…'), findsOneWidget);
    await tester.binding.handlePopRoute();
    await tester.pump();
    expect(find.text('切换历史'), findsOneWidget);
    request.completeError(ApiException(409, 'history_pending', '正在确认历史位置'));
    await tester.pumpAndSettle();
    expect(find.text('正在确认历史位置'), findsOneWidget);
    request = Completer<void>();
    await tester.tap(find.text('重试同一操作'));
    await tester.pump();
    expect(writes, 2);
    request.complete();
    await tester.pumpAndSettle();
    expect(find.text('切换历史'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('减少动态效果时加载占位不持续产生动画帧', (tester) async {
    final reply = Completer<List<String>>();
    await tester.pumpWidget(
      MaterialApp(
        home: MediaQuery(
          data: const MediaQueryData(disableAnimations: true),
          child: Scaffold(
            body: RemoteContent<List<String>>(
              load: () => reply.future,
              message: '正在加载…',
              builder: (_, data) => const Text('已加载'),
            ),
          ),
        ),
      ),
    );
    await tester.pump(const Duration(seconds: 1));
    await tester.pump();
    expect(tester.binding.hasScheduledFrame, isFalse);
    reply.complete([]);
    await tester.pumpAndSettle();
    expect(find.text('已加载'), findsOneWidget);
  });
}
