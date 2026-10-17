/** 工具展示信息：从真实参数提取动作、路径和补丁，原始数据始终保留。 */
library;

import 'dart:convert';

import 'chat.dart';

String toolRelativePath(String path, String root) {
  path = path.replaceAll('\\', '/');
  root = root.replaceAll('\\', '/').replaceFirst(RegExp(r'/$'), '');
  if (root.isNotEmpty && path.startsWith('$root/')) {
    return path.substring(root.length + 1);
  }
  if (RegExp(r'^(/|[A-Za-z]:/)').hasMatch(path)) {
    final parts = path.split('/').where((s) => s.isNotEmpty).toList();
    return '…/${parts.skip(parts.length > 2 ? parts.length - 2 : 0).join('/')}';
  }
  return path;
}

class ToolPatchFile {
  ToolPatchFile(this.path, this.action);
  final String path;
  final String action;
  String move = '';
  final List<String> lines = [];
}

class ToolPresentation {
  ToolPresentation(ToolItem tool, {String root = ''}) {
    final p = tool.input;
    String str(String key) => p[key] is String ? p[key] as String : '';
    final text =
        [
          'patch',
          'input',
          'code',
          'script',
        ].map(str).where((s) => s.isNotEmpty).firstOrNull ??
        '';
    final path =
        [
          'path',
          'file_path',
          'filePath',
        ].map(str).where((s) => s.isNotEmpty).firstOrNull ??
        '';
    final command = str('command').isNotEmpty ? str('command') : str('cmd');
    if (text.contains('*** Begin Patch')) {
      ToolPatchFile? current;
      for (final line in text.split('\n')) {
        final m = RegExp(r'^\*\*\* (Update|Add|Delete) File: (.+)\r?$')
            .firstMatch(line);
        if (m != null) {
          current = ToolPatchFile(m[2]!.trim(), m[1]!);
          files.add(current);
        } else if (current != null && line.startsWith('*** Move to: ')) {
          current.move = line.substring(13).trim();
        } else if (current != null &&
            !RegExp(r'^\*\*\* (Begin Patch|End Patch|End of File)')
                .hasMatch(line)) {
          current.lines.add(line);
        }
      }
    }
    final old = p['oldText'] ?? p['old_string'],
        next = p['newText'] ?? p['new_string'];
    if (files.isEmpty && path.isNotEmpty && old is String && next is String) {
      files.add(
        ToolPatchFile(path, 'Update')
          ..lines.addAll([
            ...old.split('\n').map((s) => '-$s'),
            ...next.split('\n').map((s) => '+$s'),
          ]),
      );
    }
    title = files.isNotEmpty
        ? '修改文件'
        : command.isNotEmpty
        ? '执行命令'
        : const {
                'read': '读取文件',
                'write': '写入文件',
                'edit': '修改文件',
                'search': '搜索',
                'grep': '搜索',
                'glob': '查找文件',
                'web': '访问网页',
                'fetch': '访问网页',
              }[tool.kind] ??
              tool.name;
    final subject = files.isNotEmpty
        ? files.map((f) => toolRelativePath(f.path, root)).join('、')
        : command.isNotEmpty
        ? command
        : path.isNotEmpty
        ? toolRelativePath(path, root)
        : tool.summary != tool.name && tool.summary.isNotEmpty
        ? tool.summary
        : text;
    target = subject.replaceAll(RegExp(r'\s+'), ' ').trim();
    params = const JsonEncoder.withIndent('  ').convert(p);
    if (p.length == 1 && (command.isNotEmpty || text.isNotEmpty)) {
      params = command.isNotEmpty ? command : text;
    }
    if (params == '{}') params = '';
    long =
        files.isNotEmpty ||
        tool.output.length > 1200 ||
        tool.output.split('\n').length > 8 ||
        params.length > 1200 ||
        params.split('\n').length > 8;
  }

  late final String title;
  late final String target;
  late String params;
  late final bool long;
  final List<ToolPatchFile> files = [];
}
