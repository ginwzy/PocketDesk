import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../data/chat.dart';
import '../../data/models.dart';
import '../tokens.dart';
import '../widgets.dart';

typedef HistoryLoader = Future<Map<String, dynamic>> Function(
  String target,
  int before,
);

class _RouteGuide {
  const _RouteGuide(this.depth, this.last, this.active, this.upper);
  final int depth;
  final bool last, active, upper;
}

class _RouteRow {
  const _RouteRow(this.turn, this.depth, this.guides, this.fork);
  final Map<String, dynamic> turn;
  final int depth;
  final List<_RouteGuide> guides;
  final bool fork;
}

class _RoutePainter extends CustomPainter {
  _RoutePainter(
    this.row,
    this.accent,
    this.line,
    this.background,
    this.hasNext,
  );
  final _RouteRow row;
  final Color accent, line, background;
  final bool hasNext;
  @override
  void paint(Canvas canvas, Size size) {
    final mid = size.height / 2;
    final depth = math.min(row.depth, 5);
    final x = 10.0 + depth * 14;
    final current = Json.boolean(row.turn['current']);
    void segment(double x1, double y1, double x2, double y2, Color color) =>
        canvas.drawLine(
          Offset(x1, y1),
          Offset(x2, y2),
          Paint()
            ..color = color
            ..strokeWidth = 2,
        );
    for (final guide in row.guides.where((g) => g.depth < depth)) {
      final gx = 10.0 + guide.depth * 14;
      segment(
        gx,
        0,
        gx,
        guide.last ? mid : size.height,
        guide.active ? accent : line,
      );
      if (row.fork && guide.depth == row.depth - 1 && guide.upper) {
        segment(gx, 0, gx, mid, accent);
      }
    }
    if (row.fork) segment(x - 14, mid, x, mid, current ? accent : line);
    segment(
      x,
      row.fork || Json.str(row.turn['parentId']).isEmpty ? mid : 0,
      x,
      hasNext ? size.height : mid,
      current ? accent : line,
    );
    segment(x, mid, size.width, mid, current ? accent : line);
    final here = Json.boolean(row.turn['here']);
    canvas.drawCircle(
      Offset(x, mid),
      here ? 6 : 4,
      Paint()..color = here ? accent : background,
    );
    canvas.drawCircle(
      Offset(x, mid),
      here ? 6 : 4,
      Paint()
        ..color = current ? accent : line
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2,
    );
  }

  @override
  bool shouldRepaint(covariant _RoutePainter old) => true;
}

/// Browsing is read-only. Only an explicit preview action returns a native target.
class HistoryPage extends StatefulWidget {
  const HistoryPage({
    super.key,
    required this.history,
    required this.loadPreview,
  });
  final Map<String, dynamic> history;
  final HistoryLoader loadPreview;
  @override
  State<HistoryPage> createState() => _HistoryPageState();
}

class _HistoryPageState extends State<HistoryPage> {
  final _expanded = <String>{'root'};
  final _scroll = ScrollController();
  final _search = TextEditingController();
  late final List<Map<String, dynamic>> _turns;
  final _children = <String, List<Map<String, dynamic>>>{};
  final _counts = <String, int>{};
  String _query = '';
  bool _hasSummary(_RouteRow row) {
    final t = row.turn;
    final id = Json.str(t['id']);
    return _query.isEmpty &&
        !_expanded.contains(id) &&
        (_children[id]?.isNotEmpty ?? false) &&
        Json.str(t['latestText']).isNotEmpty &&
        t['latestText'] != t['text'];
  }

  double _rowExtent(_RouteRow row) {
    final scale = MediaQuery.textScalerOf(context);
    return math.max(
      76,
      24 +
          scale.scale(14) * 1.35 * 2 +
          scale.scale(11) * 1.3 * (_hasSummary(row) ? 2 : 1),
    );
  }

  @override
  void initState() {
    super.initState();
    _turns = Json.list(widget.history['tree']).map(Json.map).toList();
    for (final t in _turns) {
      (_children[Json.str(t['parentId'])] ??= []).add(t);
      if (Json.boolean(t['current'])) _expanded.add(Json.str(t['id']));
    }
    for (final t in _turns.reversed) {
      final id = Json.str(t['id']);
      _counts[id] = (_counts[id] ?? 0) + 1;
      final parent = Json.str(t['parentId']);
      _counts[parent] = (_counts[parent] ?? 0) + _counts[id]!;
    }
  }

  List<_RouteRow> get _rows {
    final keep = <String>{};
    if (_query.isNotEmpty) {
      final byId = {for (final t in _turns) Json.str(t['id']): t};
      for (final t in _turns) {
        final searchable =
            '${t['text']} ${Json.list(t['replies']).map((r) => Json.map(r)['text']).join(' ')}';
        if (!searchable.toLowerCase().contains(_query)) continue;
        var cursor = Json.str(t['id']);
        while (cursor.isNotEmpty && keep.add(cursor)) {
          cursor = Json.str(byId[cursor]?['parentId']);
        }
      }
    }
    final rows = <_RouteRow>[];
    final stack = <_RouteRow>[
      for (final t in (_children[''] ?? []).reversed)
        _RouteRow(t, 0, [], false),
    ];
    while (stack.isNotEmpty) {
      final row = stack.removeLast();
      final id = Json.str(row.turn['id']);
      if (_query.isNotEmpty && !keep.contains(id)) continue;
      rows.add(row);
      final children = _children[id] ?? [];
      if (_query.isNotEmpty || _expanded.contains(id)) {
        for (var k = children.length - 1; k >= 0; k--) {
          final guides = row.guides.where((g) => !g.last).toList();
          if (children.length > 1) {
            guides.add(
              _RouteGuide(
                row.depth,
                k == children.length - 1,
                children.skip(k + 1).any((t) => Json.boolean(t['current'])),
                children.skip(k).any((t) => Json.boolean(t['current'])),
              ),
            );
          }
          stack.add(
            _RouteRow(
              children[k],
              row.depth + (children.length > 1 ? 1 : 0),
              guides,
              children.length > 1,
            ),
          );
        }
      }
    }
    return rows;
  }

  void _locate() {
    setState(() {
      _query = '';
      _search.clear();
      _expanded.addAll(
        _turns
            .where((t) => Json.boolean(t['current']))
            .map((t) => Json.str(t['id'])),
      );
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      final rows = _rows;
      final index = rows.indexWhere((r) => Json.boolean(r.turn['here']));
      final offset = rows
          .take(math.max(0, index))
          .fold<double>(0, (sum, row) => sum + _rowExtent(row));
      _scroll.animateTo(
        offset.clamp(0, _scroll.position.maxScrollExtent),
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
      );
    });
  }

  Future<void> _preview(Map<String, dynamic> turn) async {
    final selected = await Navigator.of(context).push<Map<String, dynamic>>(
      MaterialPageRoute(
        builder: (_) =>
            HistoryPreviewPage(turn: turn, loadPreview: widget.loadPreview),
      ),
    );
    if (selected != null && mounted) Navigator.pop(context, selected);
  }

  @override
  void dispose() {
    _scroll.dispose();
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.pd;
    final rows = _rows;
    return Scaffold(
      appBar: PdBar(
        title: '历史分支',
        toolbarHeight: math.max(
          PdSize.topBar,
          MediaQuery.textScalerOf(context).scale(PdFont.title) * 1.5,
        ),
      ),
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _search,
                      style: const TextStyle(fontSize: 14),
                      decoration: const InputDecoration(
                        isDense: true,
                        contentPadding: EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 12,
                        ),
                        prefixIcon: Icon(LucideIcons.search300, size: 20),
                        hintText: '搜索请求或回复',
                      ),
                      onChanged: (s) =>
                          setState(() => _query = s.trim().toLowerCase()),
                    ),
                  ),
                  const SizedBox(width: 4),
                  TextButton(onPressed: _locate, child: const Text('定位当前')),
                ],
              ),
            ),
            Expanded(
              child: rows.isEmpty
                  ? Center(
                      child: Text(
                        widget.history['tree'] == null
                            ? '请先更新电脑端，才能查看分支树'
                            : '没有匹配的对话',
                      ),
                    )
                  : ListView.builder(
                      controller: _scroll,
                      itemExtentBuilder: (i, _) => _rowExtent(rows[i]),
                      itemCount: rows.length,
                      itemBuilder: (ctx, i) {
                        final row = rows[i];
                        final t = row.turn;
                        final id = Json.str(t['id']);
                        final children = _children[id] ?? [];
                        final here = Json.boolean(t['here']);
                        final expanded =
                            _query.isNotEmpty || _expanded.contains(id);
                        final date = DateTime.tryParse(
                          Json.str(
                            !expanded && children.isNotEmpty
                                ? t['latestAt'] ?? t['timestamp']
                                : t['timestamp'],
                          ),
                        )?.toLocal();
                        final meta = [
                          if (date != null)
                            '${date.month}/${date.day} ${date.hour.toString().padLeft(2, '0')}:${date.minute.toString().padLeft(2, '0')}',
                          if (children.length > 1) '${children.length} 条后续路线',
                          if (!expanded && children.isNotEmpty)
                            '已收起 ${(_counts[id] ?? 1) - 1} 轮',
                        ].join(' · ');
                        return Padding(
                          key: ValueKey('history-turn-$id'),
                          padding: const EdgeInsets.only(left: 12, right: 8),
                          child: Row(
                            children: [
                              SizedBox(
                                width: 20 + math.min(row.depth, 5) * 14.0,
                                height: _rowExtent(row),
                                child: CustomPaint(
                                  painter: _RoutePainter(
                                    row,
                                    c.accent,
                                    c.divider,
                                    c.page,
                                    expanded && children.isNotEmpty,
                                  ),
                                ),
                              ),
                              Expanded(
                                child: Semantics(
                                  label: here ? '当前所在' : null,
                                  child: InkWell(
                                    onTap: () => _preview(t),
                                    borderRadius: BorderRadius.circular(10),
                                    child: Container(
                                      margin: const EdgeInsets.symmetric(
                                        vertical: 3,
                                      ),
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: 10,
                                        vertical: 7,
                                      ),
                                      decoration: BoxDecoration(
                                        color: here ? c.accentSoft : c.card,
                                        borderRadius: BorderRadius.circular(10),
                                        border: Border.all(
                                          color: here ? c.accent : c.divider,
                                        ),
                                      ),
                                      child: Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        mainAxisAlignment:
                                            MainAxisAlignment.center,
                                        children: [
                                          Text(
                                            Json.str(t['text']).isEmpty
                                                ? '无文字请求'
                                                : Json.str(t['text']),
                                            maxLines: 2,
                                            overflow: TextOverflow.ellipsis,
                                            style: const TextStyle(
                                              fontWeight: FontWeight.w600,
                                              fontSize: 14,
                                              height: 1.35,
                                            ),
                                          ),
                                          if (_hasSummary(row))
                                            Text(
                                              '末条请求：${t['latestText']}',
                                              maxLines: 1,
                                              overflow: TextOverflow.ellipsis,
                                              style: TextStyle(
                                                color: c.text2,
                                                fontSize: 11,
                                                height: 1.3,
                                              ),
                                            ),
                                          Row(
                                            children: [
                                              if (here) ...[
                                                Text(
                                                  '当前所在',
                                                  style: TextStyle(
                                                    color: c.accent,
                                                    fontSize: 11,
                                                    height: 1.3,
                                                    fontWeight: FontWeight.w600,
                                                  ),
                                                ),
                                                const SizedBox(width: 6),
                                              ],
                                              if (meta.isNotEmpty)
                                                Expanded(
                                                  child: Text(
                                                    meta,
                                                    maxLines: 1,
                                                    overflow:
                                                        TextOverflow.ellipsis,
                                                    style: TextStyle(
                                                      color: c.text2,
                                                      fontSize: 11,
                                                      height: 1.3,
                                                    ),
                                                  ),
                                                ),
                                            ],
                                          ),
                                        ],
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                              if (children.isNotEmpty)
                                IconButton(
                                  tooltip: expanded ? '收起后续路线' : '展开后续路线',
                                  onPressed: () => setState(() {
                                    if (expanded) {
                                      _expanded.remove(id);
                                    } else {
                                      _expanded.add(id);
                                    }
                                  }),
                                  icon: Icon(
                                    expanded
                                        ? Icons.expand_less
                                        : Icons.expand_more,
                                  ),
                                ),
                            ],
                          ),
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class HistoryPreviewPage extends StatefulWidget {
  const HistoryPreviewPage({
    super.key,
    required this.turn,
    required this.loadPreview,
    this.initialNode,
  });
  final Map<String, dynamic> turn;
  final HistoryLoader loadPreview;
  final Map<String, dynamic>? initialNode;
  @override
  State<HistoryPreviewPage> createState() => _HistoryPreviewPageState();
}

class _HistoryPreviewPageState extends State<HistoryPreviewPage> {
  late Map<String, dynamic> _node;
  final _log = ChatLog('preview');
  List<PdEvent> _events = [];
  int _before = 0;
  int _request = 0;
  bool _loading = false;
  String? _error;
  String _notice = '';
  String _targetText = '';

  @override
  void initState() {
    super.initState();
    _node =
        widget.initialNode ??
        Json.map(widget.turn['end'] ?? widget.turn['user']);
    if (_node.isNotEmpty) _load();
  }

  Future<void> _load({bool earlier = false}) async {
    final generation = ++_request;
    final target = Json.str(_node['id']);
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = await widget.loadPreview(target, earlier ? _before : -1);
      if (!mounted || generation != _request) return;
      var events = Json.list(page['events'])
          .map((e) => PdEvent.fromJson(Json.map(e)))
          .toList();
      if (earlier) events = [...events, ..._events];
      setState(() {
        _before = Json.integer(page['before']);
        _targetText = Json.str(page['targetText']);
        _events = events;
        _log.reset(events);
        _notice = Json.str(page['inputNotice']);
      });
    } catch (e) {
      if (mounted && generation == _request) {
        setState(() => _error = e.toString());
      }
    } finally {
      if (mounted && generation == _request) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.pd;
    final user = Json.map(widget.turn['user']);
    final replies = Json.list(widget.turn['replies']).map(Json.map).toList();
    final end = Json.map(widget.turn['end']);
    final choices = <Map<String, dynamic>>[
      if (user.isNotEmpty) user,
      ...replies,
      if (end.isNotEmpty && !replies.any((n) => n['id'] == end['id'])) end,
    ];
    final here = _node['mode'] != 'edit' && Json.boolean(_node['here']);
    final edit = _node['mode'] == 'edit';
    return Scaffold(
      appBar: const PdBar(title: '对话预览', subtitle: '只读查看，确认后才会切换'),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  Json.str(widget.turn['text']),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                if (choices.isNotEmpty)
                  DropdownButton<String>(
                    isExpanded: true,
                    value: Json.str(_node['id']),
                    items: choices
                        .map(
                          (n) => DropdownMenuItem(
                            value: Json.str(n['id']),
                            child: Text(
                              n['mode'] == 'edit'
                                  ? '修改这条请求'
                                  : n['role'] == 'branch'
                                  ? '这条路线最后停留的位置'
                                  : '回复 · ${Json.str(n['text'])}',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        )
                        .toList(),
                    onChanged: (id) {
                      setState(() {
                        _node = choices.firstWhere((n) => n['id'] == id);
                        _events = [];
                        _log.reset([]);
                      });
                      _load();
                    },
                  ),
                if (_notice.isNotEmpty)
                  Text(_notice, style: TextStyle(color: c.text2, fontSize: 12)),
              ],
            ),
          ),
          Expanded(
            child: _error != null
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(_error!),
                          TextButton(
                            onPressed: () => _load(),
                            child: const Text('重试预览'),
                          ),
                        ],
                      ),
                    ),
                  )
                : _loading && _events.isEmpty
                ? const Center(child: CircularProgressIndicator())
                : ListView(
                    children: [
                      if (_before > 0)
                        TextButton(
                          onPressed: _loading
                              ? null
                              : () => _load(earlier: true),
                          child: const Text('加载更早的对话'),
                        ),
                      if (_log.items.isEmpty)
                        const Padding(
                          padding: EdgeInsets.all(32),
                          child: Center(child: Text('此位置还没有对话内容')),
                        ),
                      for (final item in _log.items) _previewItem(item),
                    ],
                  ),
          ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    '原路线会保留；文件修改和已执行的命令不会撤销。',
                    style: TextStyle(color: c.text2, fontSize: 12),
                  ),
                  const SizedBox(height: 10),
                  FilledButton(
                    onPressed:
                        _node.isEmpty || here || _loading || _error != null
                        ? null
                        : () => Navigator.pop(context, {
                            ..._node,
                            if (_node['role'] == 'branch')
                              'text': widget.turn['text'],
                            if (_node['role'] != 'branch' &&
                                _targetText.isNotEmpty)
                              'text': _targetText,
                            'inputNotice': _notice,
                          }),
                    child: Text(
                      here
                          ? '当前所在位置'
                          : edit
                          ? '修改并重试'
                          : _node['id'] == end['id']
                          ? '切换到此分支'
                          : '从这里继续',
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _previewItem(ChatItem item) {
    final c = context.pd;
    if (item is ToolItem || item is ThinkingItem) {
      final title = item is ToolItem ? '工具 · ${item.name}' : '思考过程';
      final detail = item is ToolItem
          ? '${item.summary}\n${item.output}'
          : (item as ThinkingItem).text;
      return ExpansionTile(
        title: Text(title, style: TextStyle(color: c.text2, fontSize: 13)),
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: SelectableText(detail),
          ),
        ],
      );
    }
    final text = switch (item) {
      UserItem() => [
        item.text,
        ...item.attachments.map((a) => '附件：$a'),
      ].join('\n'),
      AgentItem() => item.text,
      SystemItem() => item.text,
      FileItem() => '文件：${item.name}',
      ApprovalItem() => '审批：${item.summary}（${item.status}）',
      DiffItem() => '本轮改动：${item.files.length} 个文件',
      _ => '',
    };
    if (text.isEmpty) return const SizedBox.shrink();
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: item is UserItem ? c.accentSoft : c.card,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            item is UserItem
                ? '你'
                : item is AgentItem
                ? 'Pi'
                : '记录',
            style: TextStyle(color: c.text2, fontSize: 11),
          ),
          const SizedBox(height: 6),
          SelectableText(text),
        ],
      ),
    );
  }
}
