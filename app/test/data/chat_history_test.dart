import 'package:flutter_test/flutter_test.dart';
import 'package:pocketdesk/data/chat.dart';
import 'package:pocketdesk/data/models.dart';

PdEvent event(int seq, String type, Map<String, dynamic> data) => PdEvent(session: 's', seq: seq, type: type, data: data);

void main() {
  test('回退替换投影但不倒退传输游标，后续增量仍可归并', () {
    final log = ChatLog('s');
    log.apply(event(1, 'msg.user', {'text': '原分支'}));
    log.apply(event(20, 'history.reset', {
      'leafId': 'saved', 'branchId': 'operation',
      'events': [
        {'session': 's', 'seq': -10001, 'type': 'msg.user', 'data': {'text': '保留的前文', 'entryId': 'native-u'}},
        {'session': 's', 'seq': -20001, 'type': 'msg.done', 'data': {'text': '保留的回复', 'id': 'native-a', 'entryId': 'native-a'}},
      ],
    }));
    expect(log.lastSeq, 20);
    expect(log.historyBranch, 'operation');
    expect(log.hasMoreBefore, isFalse);
    expect(log.items.length, 2);
    expect(log.items.first.entryId, 'native-u');
    log.apply(event(21, 'msg.user', {'text': '新方向'}));
    log.apply(event(22, 'msg.delta', {'id': 'pi-1', 'text': '新'}));
    log.apply(event(23, 'msg.done', {'id': 'pi-1', 'text': '新回复'}));
    log.apply(event(24, 'history.bind', {'leafId': 'new-leaf', 'bindings': [
      {'seq': 21, 'entryId': 'new-u'}, {'messageId': 'pi-1', 'entryId': 'new-a'},
    ]}));
    expect(log.items.length, 4);
    expect(log.items[2].entryId, 'new-u');
    expect(log.items.last.entryId, 'new-a');
    expect((log.items.last as AgentItem).text, '新回复');
    expect(log.lastSeq, 24);
    expect(log.historyBranch, 'operation');
    expect(log.apply(event(20, 'history.reset', {'events': []})), isFalse);
  });

  test('离线缓存重建保留分支身份，绑定事件不禁止原有历史分页', () {
    final log = ChatLog('s');
    log.prepend([event(100, 'msg.user', {'text': '最近一条'}), event(101, 'history.bind', {'leafId': 'leaf', 'bindings': [{'seq': 100, 'entryId': 'u'}]})]);
    expect(log.hasMoreBefore, isTrue);
    log.reset([event(200, 'history.reset', {'leafId': 'root', 'branchId': 'nav', 'events': []})]);
    expect(log.items, isEmpty);
    expect(log.lastSeq, 200);
    expect(log.historyBranch, 'nav');
    expect(log.hasMoreBefore, isFalse);
  });
}
