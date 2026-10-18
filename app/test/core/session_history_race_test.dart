import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:pocketdesk/core/sessions_store.dart';
import 'package:pocketdesk/data/models.dart';
import 'package:pocketdesk/net/api.dart';
import '../data/local_db_test.dart' show openTestDb;

void main() {
  test('迟到的历史 HTTP 快照不能覆盖已经收到的新分支', () async {
    final db = await openTestDb();
    final oldReadStarted = Completer<void>();
    final releaseOldRead = Completer<void>();
    final newBranchApplied = Completer<void>();
    var remote = 1;
    var switched = false;
    Map<String, dynamic> snapshot(int seq, String branch) => {
      'session': 's', 'seq': seq, 'type': 'history.reset',
      'data': {'leafId': branch, 'branchId': branch, 'events': []},
    };
    final api = PdApi(base: Uri.parse('https://fixture:1'), client: MockClient((request) async {
      Object body;
      if (request.url.path == '/api/sessions') {
        body = [{'id': 's', 'kind': 'pi', 'title': '历史', 'lastSeq': remote}];
      } else if (request.url.queryParameters.containsKey('before')) {
        oldReadStarted.complete();
        await releaseOldRead.future;
        body = [snapshot(2000, 'old-branch')];
      } else {
        final after = int.parse(request.url.queryParameters['after']!);
        body = switched && after < 2001 ? [snapshot(2001, 'new-branch')] : !switched && after == 0 ? [{'session': 's', 'seq': 1, 'type': 'msg.user', 'data': {'text': '原对话'}}] : [];
      }
      return http.Response.bytes(utf8.encode(jsonEncode(body)), 200);
    }));
    final store = SessionsStore(db: db, hostId: 'h', api: () => api);
    await store.init();
    await store.refresh();
    final log = await store.log('s');
    store.addListener(() {
      if (log.historyBranch == 'new-branch' && !newBranchApplied.isCompleted) newBranchApplied.complete();
    });
    remote = 2000;
    await store.refresh();
    await oldReadStarted.future;
    switched = true;
    store.onEvent(PdEvent.fromJson(snapshot(2001, 'new-branch')));
    await newBranchApplied.future;
    releaseOldRead.complete();
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(log.historyBranch, 'new-branch');
    expect(log.lastSeq, 2001);
    store.dispose();
    await Future<void>.delayed(const Duration(milliseconds: 10));
    await db.db.close();
  });
}
