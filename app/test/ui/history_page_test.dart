import 'dart:async';
import 'package:pocketdesk/net/api.dart';
import 'package:pocketdesk/ui/widgets.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocketdesk/ui/pages/history_page.dart';

Map<String, dynamic> node(
  String id,
  String text, {
  bool user = false,
  bool here = false,
}) => {
  'id': id,
  'text': text,
  'role': user ? 'user' : 'assistant',
  'mode': user ? 'edit' : 'continue',
  'here': here,
};
Map<String, dynamic> turn(
  String id,
  String parent,
  String text, {
  bool current = false,
  bool here = false,
}) => {
  'id': id,
  'parentId': parent,
  'text': text,
  'current': current,
  'here': here,
  'user': node(id, text, user: true),
  'end': node('a$id', '已完成：$text', here: here),
  'replies': [node('a$id', '已完成：$text', here: here)],
};
Map<String, dynamic> fixture() => {
  'tree': [
    {'id': 'root', 'text': '对话起点', 'current': true, 'replies': []},
    turn('u1', 'root', '做一个登录页面', current: true),
    turn('u2', 'u1', '改成深色风格', current: true, here: true),
    turn('u3', 'u1', '改成浅色风格'),
    turn('u4', 'u3', '浅色路线加验证码'),
  ],
};
Future<Map<String, dynamic>> preview(String id, int offset) async => {
  'total': 2,
  'before': 0,
  'targetText': '完整的原始内容',
  'inputNotice': '旧记录提示',
  'events': [
    {
      'session': 's',
      'seq': -1,
      'type': 'msg.user',
      'data': {'text': '预览中的原始请求'},
    },
    {
      'session': 's',
      'seq': -2,
      'type': 'msg.done',
      'data': {'id': 'reply', 'text': '预览中的完整回复'},
    },
  ],
};

void main() {
  Future<void> openHistory(
    WidgetTester tester,
    Future<Map<String, dynamic>> Function() load, {
    void Function(Map<String, dynamic>?)? selected,
    String entryId = '',
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () async {
                final result = await Navigator.of(context)
                    .push<Map<String, dynamic>>(
                      MaterialPageRoute(
                        builder: (_) => HistoryBrowserPage(
                          loadHistory: load,
                          loadPreview: preview,
                          entryId: entryId,
                        ),
                      ),
                    );
                selected?.call(result);
              },
              child: const Text('打开'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('打开'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 16));
  }

  testWidgets('历史页立即打开，慢请求提示可返回，迟到响应不会重新打开页面', (tester) async {
    final reply = Completer<Map<String, dynamic>>();
    await openHistory(tester, () => reply.future);
    expect(find.text('历史分支'), findsOneWidget);
    expect(find.text('正在读取会话历史…'), findsNothing);
    await tester.pump(const Duration(seconds: 4));
    expect(find.text('正在读取会话历史…'), findsOneWidget);
    await tester.tap(
      find.byWidgetPredicate((w) => w is PdIconButton && w.tooltip == '返回'),
    );
    await tester.pumpAndSettle();
    reply.complete(fixture());
    await tester.pumpAndSettle();
    expect(find.text('历史分支'), findsNothing);
    expect(find.text('打开'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('加载失败可原地重试，导航携带加载时的叶节点校验值', (tester) async {
    var calls = 0;
    Map<String, dynamic>? result;
    await openHistory(tester, () async {
      if (++calls == 1) throw ApiException(503, 'offline', '连接暂时中断');
      return {...fixture(), 'leafId': 'snapshot-leaf'};
    }, selected: (value) => result = value);
    await tester.pumpAndSettle();
    expect(find.text('连接暂时中断'), findsOneWidget);
    final bar = tester.element(find.byType(PdBar));
    await tester.tap(find.text('重试'));
    await tester.pumpAndSettle();
    expect(calls, 2);
    expect(identical(bar, tester.element(find.byType(PdBar))), isTrue);
    await tester.tap(find.text('改成浅色风格'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('切换到此分支'));
    await tester.pumpAndSettle();
    expect(result?['expectedLeaf'], 'snapshot-leaf');
    expect(result?['id'], 'au3');
    expect(tester.takeException(), isNull);
  });

  Future<void> open(
    WidgetTester tester, {
    void Function(Map<String, dynamic>?)? onSelected,
    Map<String, dynamic>? history,
    double textScale = 1,
  }) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(textScale)),
          child: child!,
        ),
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () async {
                final selected = await Navigator.of(context)
                    .push<Map<String, dynamic>>(
                      MaterialPageRoute(
                        builder: (_) => HistoryBrowserPage(
                          loadHistory: () async => history ?? fixture(),
                          loadPreview: preview,
                        ),
                      ),
                    );
                onSelected?.call(selected);
              },
              child: const Text('打开历史'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('打开历史'));
    await tester.pumpAndSettle();
  }

  testWidgets('消息入口直接预览，固定页面外壳并返回同一快照的编辑目标', (tester) async {
    final reply = Completer<Map<String, dynamic>>();
    Map<String, dynamic>? result;
    await openHistory(tester, () => reply.future, entryId: 'u1', selected: (value) => result = value);
    final bar = tester.element(find.byType(PdBar));
    reply.complete({...fixture(), 'leafId': 'snapshot', 'nodes': [node('u1', '做一个登录页面', user: true)]});
    await tester.pumpAndSettle();
    expect(identical(bar, tester.element(find.byType(PdBar))), isTrue);
    expect(find.text('对话预览'), findsOneWidget);
    await tester.tap(find.text('修改并重试'));
    await tester.pumpAndSettle();
    expect(result?['id'], 'u1');
    expect(result?['expectedLeaf'], 'snapshot');
    expect(tester.takeException(), isNull);
  });

  testWidgets('显示真实分叉，默认展开当前路线，折叠其他路线，当前位置唯一', (tester) async {
    await open(tester);
    expect(find.text('当前所在'), findsOneWidget);
    expect(find.text('2 条后续路线'), findsOneWidget);
    expect(find.text('改成深色风格'), findsOneWidget);
    expect(find.text('浅色路线加验证码'), findsNothing);
    final row = find.byKey(const ValueKey('history-turn-u3'));
    await tester.tap(
      find.descendant(of: row, matching: find.byTooltip('展开后续路线')),
    );
    await tester.pumpAndSettle();
    expect(find.text('浅色路线加验证码'), findsOneWidget);
    expect(find.text('显示分支保存位置'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('搜索保留祖先，能找到折叠分支中的消息；定位恢复当前路线', (tester) async {
    await open(tester);
    await tester.enterText(find.byType(TextField), '验证码');
    await tester.pumpAndSettle();
    expect(find.text('做一个登录页面'), findsOneWidget);
    expect(find.text('浅色路线加验证码'), findsOneWidget);
    expect(find.text('改成深色风格'), findsNothing);
    await tester.tap(find.text('定位当前'));
    await tester.pumpAndSettle();
    expect(find.text('改成深色风格'), findsOneWidget);
    expect(find.text('当前所在'), findsOneWidget);
  });

  testWidgets('点击节点只读预览，明确操作之后才返回原生导航目标', (tester) async {
    Map<String, dynamic>? selected;
    await open(tester, onSelected: (n) => selected = n);
    await tester.tap(find.text('改成浅色风格'));
    await tester.pumpAndSettle();
    expect(find.text('对话预览'), findsOneWidget);
    expect(find.text('预览中的完整回复'), findsOneWidget);
    expect(selected, isNull);
    await tester.tap(find.text('切换到此分支'));
    await tester.pumpAndSettle();
    expect(selected?['id'], 'au3');
    expect(selected?['mode'], 'continue');
    expect(tester.takeException(), isNull);
  });

  testWidgets('当前位置不重复切换，但仍可选择修改当前请求', (tester) async {
    Map<String, dynamic>? selected;
    await open(tester, onSelected: (n) => selected = n);
    await tester.tap(find.text('改成深色风格'));
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<FilledButton>(find.widgetWithText(FilledButton, '当前所在位置'))
          .onPressed,
      isNull,
    );
    await tester.tap(find.byType(DropdownButton<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('修改这条请求').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('修改并重试'));
    await tester.pumpAndSettle();
    expect(selected?['id'], 'u2');
    expect(selected?['mode'], 'edit');
    expect(selected?['text'], '完整的原始内容');
    expect(selected?['inputNotice'], '旧记录提示');
  });
  testWidgets('紧凑节点保留双行标题和折叠摘要，大字体定位不溢出', (tester) async {
    final history = {
      'tree': [
        {'id': 'root', 'text': '对话起点', 'current': true},
        for (var i = 1; i <= 14; i++)
          {
            ...turn(
              'u$i',
              i == 1 ? 'root' : 'u${i - 1}',
              'review 当前修改，找到可以简化的地方和架构的问题优化',
              current: true,
              here: i == 14,
            ),
            'timestamp': '2026-10-18T16:51:00+08:00',
          },
        {...turn('old', 'u3', '另一条路线'), 'latestText': '补充最后一条请求'},
        turn('old-child', 'old', '补充最后一条请求'),
      ],
    };
    await open(tester, history: history);
    expect(
      tester.getSize(find.byKey(const ValueKey('history-turn-u1'))).height,
      lessThan(80),
    );
    await tester.tap(find.text('定位当前'));
    await tester.pumpAndSettle();
    expect(tester.getRect(find.text('当前所在')).bottom, lessThan(844));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    await open(tester, history: history, textScale: 2);
    await tester.tap(find.text('定位当前'));
    await tester.pumpAndSettle();
    expect(tester.getRect(find.text('当前所在')).bottom, lessThan(844));
    expect(find.text('末条请求：补充最后一条请求'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
