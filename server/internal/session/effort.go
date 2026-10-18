package session

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/ewkzcz/pocketdesk/server/internal/agent"
	"github.com/ewkzcz/pocketdesk/server/internal/store"
)

type EffortInfo struct {
	agent.EffortState
	Override string        `json:"override"`
	Session  store.Session `json:"session"`
}

// EffortError 是可以直接向用户解释的 Pi 操作错误。
type EffortError struct{ Err error }

func (e *EffortError) Error() string { return e.Err.Error() }
func (e *EffortError) Unwrap() error { return e.Err }

// Effort 统一服务手机和桌面：查询或修改时都回读 Pi 实际生效的值。
func (m *Manager) Effort(ctx context.Context, id string, level *string) (EffortInfo, error) {
	var info EffortInfo
	if level != nil {
		// 与发送消息一致：客户端断线后仍完成已开始的修改，避免 Pi 已生效但未保存。
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
	}
	if !m.d.Config().Features.Agents {
		return info, ErrDisabled
	}
	if m.closed.Load() {
		return info, ErrClosed
	}
	rt, err := m.runtime(ctx, id)
	if err != nil {
		return info, err
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if rt.historyBlocked {
		return info, ErrHistoryPending
	}
	if err := checkHistoryFile(rt); err != nil {
		return info, err
	}
	if rt.sess.Kind != agent.KindPi {
		return info, &EffortError{fmt.Errorf("/effort 当前仅支持 Pi 会话：%w", agent.ErrUnsupported)}
	}
	if rt.state == StateRunning || rt.state == StateAwaiting || rt.state == StateInterrupted {
		return info, ErrBusy
	}
	if level != nil && (strings.TrimSpace(*level) == "" || strings.ContainsAny(*level, " \t\r\n")) {
		return info, &EffortError{fmt.Errorf("用法：/effort <强度>，或 /effort default 恢复默认")}
	}
	if rt.proc == nil {
		cwd, err := m.absCwd(ctx, rt.sess)
		if err != nil {
			return info, err
		}
		rt.proc, err = m.startProc(ctx, rt, rt.sess.Kind, cwd, rt.sess.AgentSessionID, rt.sess.Model)
		if err != nil {
			return info, &EffortError{err}
		}
	}
	controller, ok := rt.proc.(agent.EffortController)
	if !ok {
		return info, &EffortError{fmt.Errorf("当前驱动不支持思考强度操作，请更新 Pi：%w", agent.ErrUnsupported)}
	}
	var state agent.EffortState
	if level == nil {
		state, err = controller.Effort(ctx)
	} else {
		state, err = controller.SetEffort(ctx, *level)
	}
	if err != nil {
		// 请求失败时不保存新设置；结束空闲进程，避免响应丢失后进程与数据库不一致。
		if level != nil {
			old := rt.proc
			rt.proc = nil
			old.Close()
		}
		return info, &EffortError{err}
	}
	patch := store.SessionPatch{}
	if state.SessionID != "" && state.SessionID != rt.sess.AgentSessionID {
		patch.AgentSessionID = &state.SessionID
	}
	if rt.sess.Model == "" && state.Model != "" {
		patch.Model = &state.Model
	}
	if level != nil {
		patch.Effort = level
	}
	if patch.AgentSessionID != nil || patch.Model != nil || patch.Effort != nil {
		s, err := m.d.Store.UpdateSession(ctx, id, patch)
		if err != nil {
			old := rt.proc
			rt.proc = nil
			old.Close()
			return info, err
		}
		rt.sess = s
		m.d.Hub.PublishGlobal("session.updated", s)
	}
	if level != nil {
		text := "思考强度已设为 " + state.Level
		if *level == "default" {
			text = "思考强度已恢复跟随 Pi 配置，当前为 " + state.Level
		} else if *level != state.Level {
			text = "当前模型实际思考强度为 " + state.Level + "（请求 " + *level + "）"
		}
		m.emit(ctx, id, "system", map[string]any{"text": text})
	}
	return EffortInfo{EffortState: state, Override: rt.sess.Effort, Session: rt.sess}, nil
}
