/** 连续工具的执行过程、短结果预览和可实时更新的独立详情页。 */
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../data/chat.dart';
import '../../data/tool_presentation.dart';
import '../tokens.dart';
import '../widgets.dart';

class ToolActivity extends StatefulWidget {
  const ToolActivity({
    super.key,
    required this.tools,
    this.root = '',
    this.updates,
    this.lookupTool,
    this.onLongPress,
  });
  final List<ToolItem> tools;
  final String root;
  final Listenable? updates;
  final ToolItem? Function(int seq)? lookupTool;
  final ValueChanged<ToolItem>? onLongPress;

  @override
  State<ToolActivity> createState() => _ToolActivityState();
}

class _ToolActivityState extends State<ToolActivity> {
  bool? _expanded;
  final Set<int> _previews = {};

  void _open(ToolItem tool, {bool detail = false}) {
    if (!detail && !ToolPresentation(tool, root: widget.root).long) {
      setState(() {
        _expanded = true;
        _previews.contains(tool.seq)
            ? _previews.remove(tool.seq)
            : _previews.add(tool.seq);
      });
      return;
    }
    setState(() => _expanded = true);
    final page = ToolDetailPage(
      tool: tool,
      root: widget.root,
      updates: widget.updates,
      lookupTool: widget.lookupTool,
    );
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => page));
  }

  @override
  Widget build(BuildContext context) {
    final c = context.pd;
    final tools = widget.tools;
    final running = tools.where((t) => !t.done).length;
    final failed = tools.where((t) => t.done && t.isError).length;
    final open = _expanded ?? (running > 0 || failed > 0);
    final caption = failed > 0
        ? '${tools.length} 项操作 · $failed 项失败'
        : running > 0
        ? '${tools.length - running}/${tools.length} 项已完成'
        : '${tools.length} 项操作已完成';
    return SizedBox(
      width: double.infinity,
      child: Material(
        color: c.tool,
        borderRadius: BorderRadius.circular(PdSize.smallRadius),
        clipBehavior: Clip.antiAlias,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            InkWell(
              onTap: () => setState(() => _expanded = !open),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 12,
                ),
                child: Row(
                  children: [
                    Icon(
                      open
                          ? LucideIcons.chevronDown300
                          : LucideIcons.chevronRight300,
                      size: 15,
                      color: c.text3,
                    ),
                    const SizedBox(width: 6),
                    Text(
                      '执行过程',
                      style: TextStyle(fontSize: 12, color: c.text2),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        caption,
                        textAlign: TextAlign.end,
                        style: TextStyle(
                          fontSize: 11,
                          color: failed > 0 ? c.danger : c.text3,
                        ),
                      ),
                    ),
                    if (running > 0) ...[
                      const SizedBox(width: 6),
                      _ToolStatus(tool: tools.firstWhere((t) => !t.done)),
                    ],
                  ],
                ),
              ),
            ),
            for (final tool in tools.where((t) => open || t.isError)) ...[
              Divider(height: 1, color: c.divider),
              _toolRow(tool),
              if (open && _previews.contains(tool.seq)) _preview(tool),
            ],
          ],
        ),
      ),
    );
  }

  Widget _toolRow(ToolItem tool) {
    final c = context.pd;
    final d = ToolPresentation(tool, root: widget.root);
    final command = d.title == '执行命令' && d.target.isNotEmpty;
    return InkWell(
      onTap: () => _open(tool),
      onLongPress: widget.onLongPress == null
          ? null
          : () => widget.onLongPress!(tool),
      child: Container(
        constraints: const BoxConstraints(minHeight: 44),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: _ToolStatus(tool: tool),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    command ? d.target : d.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12,
                      color: tool.isError ? c.danger : c.text2,
                      fontFamily: command ? PdFont.mono : null,
                      fontFamilyFallback: command ? PdFont.monoFallback : null,
                    ),
                  ),
                  if (d.target.isNotEmpty && !command)
                    Text(
                      d.target,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12,
                        color: c.text3,
                        fontFamily: PdFont.mono,
                        fontFamilyFallback: PdFont.monoFallback,
                      ),
                    ),
                  if (tool.isError && tool.output.trim().isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 3),
                      child: Text(
                        tool.output.trim().split('\n').first,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 12, color: c.danger),
                      ),
                    ),
                ],
              ),
            ),
            if (d.files.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(left: 6),
                child: Text(
                  '${d.files.length} 文件',
                  style: TextStyle(fontSize: 11, color: c.text3),
                ),
              ),
            const SizedBox(width: 4),
            Icon(LucideIcons.chevronRight300, size: 15, color: c.text4),
          ],
        ),
      ),
    );
  }

  Widget _preview(ToolItem tool) {
    final c = context.pd;
    var text = tool.output.split('\n').take(8).join('\n');
    if (text.length > 1200) text = text.substring(0, 1200);
    if (text.length < tool.output.length) text += '\n…';
    return Padding(
      padding: const EdgeInsets.fromLTRB(33, 0, 12, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  tool.isError ? '错误' : '结果',
                  style: TextStyle(fontSize: 11, color: c.text3),
                ),
              ),
              TextButton(
                onPressed: () => _open(tool, detail: true),
                child: const Text('查看详情', style: TextStyle(fontSize: 12)),
              ),
            ],
          ),
          SelectableText(
            text.isNotEmpty
                ? text
                : !tool.done
                ? '等待工具返回结果…'
                : '工具已完成，没有文本输出',
            style: TextStyle(
              fontSize: 12,
              height: 1.5,
              color: c.text2,
              fontFamily: PdFont.mono,
              fontFamilyFallback: PdFont.monoFallback,
            ),
          ),
        ],
      ),
    );
  }
}

class _ToolStatus extends StatelessWidget {
  const _ToolStatus({required this.tool});
  final ToolItem tool;

  @override
  Widget build(BuildContext context) => Semantics(
    label: !tool.done
        ? '执行中'
        : tool.isError
        ? '执行失败'
        : '执行完成',
    child: tool.done
        ? Icon(
            tool.isError ? LucideIcons.circleX300 : LucideIcons.check300,
            size: 15,
            color: tool.isError ? context.pd.danger : context.pd.accent,
          )
        : SizedBox(
            width: 15,
            height: 15,
            child: CircularProgressIndicator(
              strokeWidth: 1.5,
              color: context.pd.text3,
            ),
          ),
  );
}

class ToolDetailPage extends StatefulWidget {
  const ToolDetailPage({
    super.key,
    required this.tool,
    this.root = '',
    this.updates,
    this.lookupTool,
  });
  final ToolItem tool;
  final String root;
  final Listenable? updates;
  final ToolItem? Function(int seq)? lookupTool;

  @override
  State<ToolDetailPage> createState() => _ToolDetailPageState();
}

class _ToolDetailPageState extends State<ToolDetailPage> {
  String _tab = 'result';
  bool _wrap = true;

  String _content(ToolItem t, ToolPresentation d) {
    if (_tab == 'raw') {
      return const JsonEncoder.withIndent('  ').convert({
        'tool': t.name,
        'input': t.input,
        'output': t.output,
        'done': t.done,
        'isError': t.isError,
      });
    }
    if (_tab == 'params') return d.params.isEmpty ? '没有参数' : d.params;
    if (d.files.isNotEmpty) {
      return [
        ...d.files.map((f) => '${f.path}\n${f.lines.join('\n')}'),
        if (t.output.isNotEmpty) t.output,
      ].join('\n\n');
    }
    return t.output.isNotEmpty
        ? t.output
        : !t.done
        ? '等待工具返回结果…'
        : '工具已完成，没有文本输出';
  }

  Future<void> _copy(String text) async {
    await Clipboard.setData(ClipboardData(text: text));
    if (mounted) toast(context, '已复制');
  }

  @override
  Widget build(BuildContext context) => widget.updates == null
      ? _page()
      : ListenableBuilder(
          listenable: widget.updates!,
          builder: (_, _) => _page(),
        );

  Widget _page() {
    final c = context.pd;
    // 重同步会替换工具对象；详情与复制都从当前记录读取。
    final t = widget.lookupTool == null
        ? widget.tool
        : widget.lookupTool!(widget.tool.seq);
    if (t == null) {
      return Scaffold(
        appBar: const PdBar(title: '工具详情'),
        body: SafeArea(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Text(
                '暂时无法显示这项操作，请返回聊天重新查看。',
                style: TextStyle(color: c.text3),
                textAlign: TextAlign.center,
              ),
            ),
          ),
        ),
      );
    }
    final d = ToolPresentation(t, root: widget.root);
    final mono = TextStyle(
      fontSize: 12,
      height: 1.6,
      color: c.text2,
      fontFamily: PdFont.mono,
      fontFamilyFallback: PdFont.monoFallback,
    );
    Widget code(String text, {bool diff = false}) {
      final child = diff
          ? SelectableText.rich(
              TextSpan(
                style: mono,
                children: [
                  for (final l in text.split('\n'))
                    TextSpan(
                      text: '$l\n',
                      style: l.startsWith('+')
                          ? TextStyle(
                              color: c.accent,
                              backgroundColor: c.accentSoft,
                            )
                          : l.startsWith('-')
                          ? TextStyle(
                              color: c.danger,
                              backgroundColor: c.danger.withValues(alpha: .08),
                            )
                          : null,
                    ),
                ],
              ),
            )
          : SelectableText(text, style: mono);
      return Padding(
        padding: const EdgeInsets.only(bottom: 16),
        child: _wrap
            ? child
            : SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: child,
              ),
      );
    }

    Widget label(String text) => Padding(
      padding: const EdgeInsets.only(bottom: 10, top: 4),
      child: Text(text, style: TextStyle(fontSize: 11, color: c.text3)),
    );
    return Scaffold(
      appBar: PdBar(
        title: '工具详情',
        actions: [
          PdIconButton(
            icon: LucideIcons.wrapText300,
            tooltip: _wrap ? '关闭自动换行' : '自动换行',
            onTap: () => setState(() => _wrap = !_wrap),
          ),
          PdIconButton(
            icon: LucideIcons.copy300,
            tooltip: '复制当前内容',
            onTap: () => _copy(_content(t, d)),
          ),
        ],
      ),
      body: SafeArea(
        top: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
              child: Row(
                children: [
                  _ToolStatus(tool: t),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      d.title,
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        color: c.text,
                      ),
                    ),
                  ),
                  Text(
                    !t.done
                        ? '执行中'
                        : t.isError
                        ? '执行失败'
                        : '执行完成',
                    style: TextStyle(
                      fontSize: 12,
                      color: t.isError ? c.danger : c.text3,
                    ),
                  ),
                ],
              ),
            ),
            if (d.target.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: Text(
                  d.target,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: mono.copyWith(fontSize: 11, color: c.text3),
                ),
              ),
            Row(
              children: [
                for (final tab in [
                  ('result', '结果'),
                  ('params', '参数'),
                  ('raw', '原始数据'),
                ])
                  Expanded(
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        border: Border(
                          bottom: BorderSide(
                            width: _tab == tab.$1 ? 2 : 1,
                            color: _tab == tab.$1 ? c.accent : c.divider,
                          ),
                        ),
                      ),
                      child: TextButton(
                        onPressed: () => setState(() => _tab = tab.$1),
                        style: TextButton.styleFrom(
                          minimumSize: const Size(0, 44),
                          foregroundColor: _tab == tab.$1 ? c.text : c.text3,
                        ),
                        child: Text(
                          tab.$2,
                          style: const TextStyle(fontSize: 12),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
            Expanded(
              child: SingleChildScrollView(
                key: PageStorageKey('tool-${t.seq}-$_tab'),
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (_tab == 'result' && d.files.isNotEmpty) ...[
                      label('补丁内容 · ${d.files.length} 个文件'),
                      for (final file in d.files) ...[
                        Row(
                          children: [
                            Expanded(
                              child: Text(
                                toolRelativePath(file.path, widget.root),
                                style: mono,
                              ),
                            ),
                            IconButton(
                              tooltip: '复制完整路径',
                              icon: const Icon(LucideIcons.copy300, size: 16),
                              onPressed: () => _copy(file.path),
                            ),
                          ],
                        ),
                        if (file.action == 'Delete') label('删除文件'),
                        if (file.move.isNotEmpty)
                          label(
                            '移动到 ${toolRelativePath(file.move, widget.root)}',
                          ),
                        code(file.lines.join('\n'), diff: true),
                      ],
                      if (t.output.isNotEmpty) ...[
                        label('执行结果'),
                        code(t.output),
                      ],
                    ] else
                      code(_content(t, d)),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
