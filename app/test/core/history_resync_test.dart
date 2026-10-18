import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:pocketdesk/core/sessions_store.dart';
import 'package:pocketdesk/data/chat.dart';
import 'package:pocketdesk/net/api.dart';

import '../data/local_db_test.dart' show openTestDb;

void main() {
  test('包含历史快照的补拉达到服务端上限后，继续拉到已知最新序号', () async {
    final db = await openTestDb();
    var remote = 1;
    final refreshed = Completer<void>();
    Map<String, dynamic> event(
      int seq,
      String type,
      Map<String, dynamic> data,
    ) => {'session': 's', 'seq': seq, 'type': type, 'data': data};
    final reset = event(100, 'history.reset', {
      'branchId': 'branch',
      'leafId': 'leaf',
      'events': [],
    });
    final live = [
      for (var i = 101; i <= 7000; i++)
        event(
          i,
          i == 7000 ? 'msg.done' : 'state',
          i == 7000 ? {'id': 'last', 'text': '最新回复'} : {'state': 'idle'},
        ),
    ];
    final api = PdApi(
      base: Uri.parse('https://fixture:1'),
      client: MockClient((request) async {
        Object body;
        if (request.url.path == '/api/sessions') {
          body = [
            {'id': 's', 'kind': 'pi', 'lastSeq': remote},
          ];
        } else if (request.url.queryParameters.containsKey('before')) {
          // EventsBefore must include the branch reset, capped at 5000 events.
          body = [reset, ...live.take(4999)];
        } else {
          final after = int.parse(request.url.queryParameters['after']!);
          body = remote == 1
              ? [
                  event(1, 'msg.user', {'text': '旧消息'}),
                ]
              : live.where((e) => (e['seq'] as int) > after).take(500).toList();
        }
        return http.Response.bytes(utf8.encode(jsonEncode(body)), 200);
      }),
    );
    final store = SessionsStore(db: db, hostId: 'h', api: () => api);
    try {
      await store.init();
      await store.refresh();
      final log = await store.log('s');
      store.addListener(() {
        if (log.lastSeq > 1 && !refreshed.isCompleted) refreshed.complete();
      });
      remote = 7000;
      await store.refresh();
      await refreshed.future;
      expect(log.lastSeq, 7000);
      expect(log.items.whereType<AgentItem>().single.text, '最新回复');
    } finally {
      store.dispose();
      await Future<void>.delayed(const Duration(milliseconds: 10));
      await db.db.close();
    }
  });
  test('并发补拉调用共享完成结果，await 不会提前结束', () async {
    final db = await openTestDb();
    final started = Completer<void>();
    final release = Completer<void>();
    var gated = false;
    final api = PdApi(
      base: Uri.parse('https://fixture:1'),
      client: MockClient((req) async {
        if (req.url.path == '/api/sessions') {
          return http.Response('[{"id":"s","kind":"pi","lastSeq":0}]', 200);
        }
        if (gated) {
          if (!started.isCompleted) started.complete();
          await release.future;
        }
        return http.Response(
          gated && req.url.queryParameters['after'] == '0'
              ? '[{"session":"s","seq":1,"type":"state","data":{"state":"idle"}}]'
              : '[]',
          200,
        );
      }),
    );
    final store = SessionsStore(db: db, hostId: 'h', api: () => api);
    await store.init();
    await store.refresh();
    await store.log('s');
    gated = true;
    final first = store.catchUp('s');
    await started.future;
    final second = store.catchUp('s');
    var finished = false;
    unawaited(second.then((_) { finished = true; }));
    try {
      await Future<void>.delayed(Duration.zero);
      expect(finished, isFalse, reason: '调用方还不能使用尚未同步完成的聊天投影');
    } finally {
      release.complete();
      await Future.wait([first, second]);
      store.dispose();
      await Future<void>.delayed(const Duration(milliseconds: 10));
      await db.db.close();
    }
  });
}
