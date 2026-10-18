import 'dart:async';

import 'package:flutter/material.dart';

import '../net/api.dart';
import 'tokens.dart';

String _message(Object error) =>
    error is ApiException ? error.message : '操作失败，请重试';

void _reportUnexpected(Object error, StackTrace stack) {
  if (error is! ApiException) {
    FlutterError.reportError(
      FlutterErrorDetails(
        exception: error,
        stack: stack,
        library: 'PocketDesk async UI',
      ),
    );
  }
}

/// Opens the destination before reading remote data. Disposed pages and older
/// attempts cannot publish a late result into a newer view.
class RemoteContent<T extends Object> extends StatefulWidget {
  const RemoteContent({
    super.key,
    required this.load,
    required this.builder,
    required this.message,
    this.tree = false,
    this.frameBuilder,
  });
  final Future<T> Function() load;
  final Widget Function(BuildContext, T) builder;
  final String message;
  final bool tree;
  // The surrounding page stays outside the content transition.
  final Widget Function(Widget, T?)? frameBuilder;
  @override
  State<RemoteContent<T>> createState() => _RemoteContentState<T>();
}

class _RemoteContentState<T extends Object> extends State<RemoteContent<T>> {
  T? _data;
  Object? _error;
  bool _show = false, _slow = false;
  int _generation = 0;
  Timer? _delay, _notice;
  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    final generation = ++_generation;
    _delay?.cancel();
    _notice?.cancel();
    setState(() {
      _data = null;
      _error = null;
      _show = false;
      _slow = false;
    });
    _delay = Timer(const Duration(milliseconds: 150), () {
      if (mounted) setState(() => _show = true);
    });
    _notice = Timer(const Duration(seconds: 3), () {
      if (mounted) setState(() => _slow = true);
    });
    try {
      final result = await widget.load();
      if (mounted && generation == _generation) setState(() => _data = result);
    } catch (error, stack) {
      _reportUnexpected(error, stack);
      if (mounted && generation == _generation) setState(() => _error = error);
    } finally {
      if (generation == _generation) {
        _delay?.cancel();
        _notice?.cancel();
      }
    }
  }

  @override
  void dispose() {
    _delay?.cancel();
    _notice?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    Widget child;
    if (_data != null) {
      child = KeyedSubtree(
        key: ValueKey('ready-$_generation'),
        child: widget.builder(context, _data!),
      );
    } else {
      child = _error != null
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(_message(_error!), textAlign: TextAlign.center),
                    const SizedBox(height: 12),
                    OutlinedButton(onPressed: _load, child: const Text('重试')),
                  ],
                ),
              ),
            )
          : Semantics(
              liveRegion: true,
              label: widget.message,
              child: _LoadingRows(
                show: _show,
                slow: _slow,
                message: widget.message,
                tree: widget.tree,
              ),
            );
      child = KeyedSubtree(key: const ValueKey('waiting'), child: child);
    }
    final content = AnimatedSwitcher(
      duration: MediaQuery.disableAnimationsOf(context)
          ? Duration.zero
          : const Duration(milliseconds: 120),
      child: child,
    );
    return widget.frameBuilder?.call(content, _data) ?? content;
  }
}

class _LoadingRows extends StatefulWidget {
  const _LoadingRows({
    required this.show,
    required this.slow,
    required this.message,
    required this.tree,
  });
  final bool show, slow, tree;
  final String message;
  @override
  State<_LoadingRows> createState() => _LoadingRowsState();
}

class _LoadingRowsState extends State<_LoadingRows>
    with SingleTickerProviderStateMixin {
  late final _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  );
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context)) {
      _pulse.stop();
      _pulse.value = 1;
    } else {
      _pulse.repeat(reverse: true);
    }
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.pd;
    return SingleChildScrollView(
      physics: const NeverScrollableScrollPhysics(),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
        child: Column(
          children: [
            Opacity(
              opacity: widget.show ? 1 : 0,
              child: ExcludeSemantics(
                child: FadeTransition(
                  opacity: Tween<double>(begin: 0.45, end: 1).animate(_pulse),
                  child: Column(
                    children: List.generate(
                      widget.tree ? 6 : 5,
                      (i) => SizedBox(
                        height: widget.tree ? 76 : 52,
                        child: Row(
                          children: [
                            if (widget.tree)
                              Container(
                                width: 2,
                                margin: const EdgeInsets.only(
                                  left: 4,
                                  right: 16,
                                ),
                                color: c.divider,
                              ),
                            Expanded(
                              child: Column(
                                mainAxisAlignment: MainAxisAlignment.center,
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  FractionallySizedBox(
                                    widthFactor: i.isEven ? 0.72 : 0.5,
                                    child: Container(
                                      height: 12,
                                      decoration: BoxDecoration(
                                        color: c.divider,
                                        borderRadius: BorderRadius.circular(4),
                                      ),
                                    ),
                                  ),
                                  const SizedBox(height: 8),
                                  FractionallySizedBox(
                                    widthFactor: 0.3,
                                    child: Container(
                                      height: 8,
                                      decoration: BoxDecoration(
                                        color: c.divider,
                                        borderRadius: BorderRadius.circular(4),
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
            SizedBox(
              height: 28,
              child: widget.slow
                  ? Center(
                      child: Text(
                        widget.message,
                        style: TextStyle(color: c.text2, fontSize: 12),
                      ),
                    )
                  : null,
            ),
          ],
        ),
      ),
    );
  }
}

class RemoteChoice {
  const RemoteChoice(
    this.label, {
    required this.select,
    this.icon,
    this.subtitle = '',
    this.prepare,
  });
  final String label, subtitle;
  final IconData? icon;
  // User input is completed before submission progress starts.
  final Future<bool> Function(BuildContext)? prepare;
  final Future<void> Function() select;
}

Future<bool?> remoteChoiceSheet(
  BuildContext context, {
  required String title,
  required String message,
  required Future<List<RemoteChoice>> Function() load,
}) => showModalBottomSheet<bool>(
  context: context,
  isScrollControlled: true,
  enableDrag: false,
  builder: (_) =>
      _RemoteChoiceSheet(title: title, message: message, load: load),
);

class _RemoteChoiceSheet extends StatefulWidget {
  const _RemoteChoiceSheet({
    required this.title,
    required this.message,
    required this.load,
  });
  final String title, message;
  final Future<List<RemoteChoice>> Function() load;
  @override
  State<_RemoteChoiceSheet> createState() => _RemoteChoiceSheetState();
}

class _RemoteChoiceSheetState extends State<_RemoteChoiceSheet> {
  int? _busy;
  bool _preparing = false;
  String _error = '';
  Future<void> _select(int i, RemoteChoice choice) async {
    if (_busy != null || _preparing) return;
    _preparing = true;
    try {
      if (choice.prepare != null && !await choice.prepare!(context)) return;
      if (!mounted) return;
      setState(() {
        _busy = i;
        _error = '';
      });
      await choice.select();
      if (mounted) Navigator.pop(context, true);
    } catch (e, stack) {
      _reportUnexpected(e, stack);
      if (mounted) setState(() => _error = _message(e));
    } finally {
      _preparing = false;
      if (mounted) setState(() => _busy = null);
    }
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: _busy == null,
    child: SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.8,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 8, 8),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      widget.title,
                      style: const TextStyle(fontWeight: FontWeight.w600),
                    ),
                  ),
                  IconButton(
                    tooltip: '关闭',
                    onPressed: _busy == null
                        ? () => Navigator.pop(context)
                        : null,
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
            ),
            Flexible(
              child: AnimatedSize(
                duration: MediaQuery.disableAnimationsOf(context)
                    ? Duration.zero
                    : const Duration(milliseconds: 180),
                alignment: Alignment.topCenter,
                child: RemoteContent<List<RemoteChoice>>(
                  load: widget.load,
                  message: widget.message,
                  builder: (ctx, choices) => ListView.separated(
                    shrinkWrap: true,
                    padding: EdgeInsets.zero,
                    itemCount: choices.length,
                    separatorBuilder: (_, _) => const Divider(height: 1),
                    itemBuilder: (_, i) => ListTile(
                      title: Text(
                        choices[i].label,
                        style: _busy == i
                            ? TextStyle(color: context.pd.text)
                            : null,
                      ),
                      subtitle: _busy == i
                          ? Text(
                              '正在切换…',
                              style: TextStyle(color: context.pd.accent),
                            )
                          : choices[i].subtitle.isEmpty
                          ? null
                          : Text(choices[i].subtitle),
                      trailing: _busy == i
                          ? RemoteSpinner(color: context.pd.accent)
                          : choices[i].icon == null
                          ? null
                          : Icon(choices[i].icon, size: 20),
                      enabled: _busy == null,
                      onTap: () => _select(i, choices[i]),
                    ),
                  ),
                ),
              ),
            ),
            if (_error.isNotEmpty)
              Padding(
                padding: const EdgeInsets.all(16),
                child: Text(
                  '$_error\n可重新选择后重试',
                  style: TextStyle(color: context.pd.danger),
                ),
              ),
          ],
        ),
      ),
    ),
  );
}

class RemoteSpinner extends StatelessWidget {
  const RemoteSpinner({super.key, this.color});
  final Color? color;
  @override
  Widget build(BuildContext context) => SizedBox(
    width: 18,
    height: 18,
    child: CircularProgressIndicator(
      strokeWidth: 2,
      color: color ?? DefaultTextStyle.of(context).style.color,
      value: MediaQuery.disableAnimationsOf(context) ? 0.65 : null,
    ),
  );
}

/// Keeps the confirmation visible while a mutation is awaiting acknowledgement.
class RemoteConfirmation extends StatefulWidget {
  const RemoteConfirmation({
    super.key,
    required this.title,
    required this.content,
    required this.confirm,
    required this.run,
    this.working = '正在切换…',
    this.retryable,
    this.startImmediately = false,
  });
  final String title, confirm, working;
  final Widget content;
  final Future<void> Function() run;
  final bool Function(Object)? retryable;
  final bool startImmediately;
  @override
  State<RemoteConfirmation> createState() => _RemoteConfirmationState();
}

class _RemoteConfirmationState extends State<RemoteConfirmation> {
  bool _busy = false;
  Object? _error;
  @override
  void initState() {
    super.initState();
    if (widget.startImmediately) unawaited(_run());
  }

  Future<void> _run() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.run();
      if (mounted) Navigator.pop(context, true);
    } catch (e, stack) {
      _reportUnexpected(e, stack);
      if (mounted) setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: !_busy,
    child: AlertDialog(
      title: Text(widget.title),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            widget.content,
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 16),
                child: Text(
                  _message(_error!),
                  style: TextStyle(color: context.pd.danger),
                ),
              ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.pop(context, false),
          child: Text(_error == null ? '取消' : '返回'),
        ),
        FilledButton(
          onPressed:
              _busy ||
                  (_error != null && !(widget.retryable?.call(_error!) ?? true))
              ? null
              : _run,
          child: _busy
              ? Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const RemoteSpinner(),
                    const SizedBox(width: 8),
                    Text(widget.working),
                  ],
                )
              : Text(_error == null ? widget.confirm : '重试同一操作'),
        ),
      ],
    ),
  );
}
