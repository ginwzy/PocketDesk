package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"
)

// EffortState 包含 Pi 回读的实际强度与当前模型支持的档位。
type EffortState struct {
	Level     string   `json:"level"`
	Levels    []string `json:"levels"`
	Model     string   `json:"model"`
	SessionID string   `json:"-"`
}

type EffortController interface {
	Effort(context.Context) (EffortState, error)
	SetEffort(context.Context, string) (EffortState, error)
}

type piResponse struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Success bool            `json:"success"`
	Error   string          `json:"error"`
	Data    json.RawMessage `json:"data"`
}

type piProc struct {
	*lineProc
	opt     Options
	rmu     sync.Mutex
	nextID  uint64
	pending map[string]chan piResponse
}

// Pi 的协议与 JSON-RPC 不同；仅消费带本驱动请求编号的响应，保留正常聊天事件。
func (p *piProc) resolve(line []byte) bool {
	var r piResponse
	if json.Unmarshal(line, &r) != nil || r.Type != "response" || !strings.HasPrefix(r.ID, "pd-effort-") {
		return false
	}
	p.rmu.Lock()
	ch := p.pending[r.ID]
	p.rmu.Unlock()
	if ch != nil {
		select {
		case ch <- r:
		default:
		}
	}
	return true
}

func (p *piProc) call(ctx context.Context, command string, fields map[string]any, out any) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	p.rmu.Lock()
	p.nextID++
	id := fmt.Sprintf("pd-effort-%d", p.nextID)
	ch := make(chan piResponse, 1)
	p.pending[id] = ch
	p.rmu.Unlock()
	defer func() { p.rmu.Lock(); delete(p.pending, id); p.rmu.Unlock() }()
	if fields == nil {
		fields = map[string]any{}
	}
	fields["id"], fields["type"] = id, command
	if err := p.writeJSON(fields); err != nil {
		return err
	}
	select {
	case r := <-ch:
		if !r.Success {
			return fmt.Errorf("Pi 无法执行思考强度操作，请确认版本支持 /effort：%s", r.Error)
		}
		if out != nil {
			return json.Unmarshal(r.Data, out)
		}
		return nil
	case <-p.Done():
		return errors.New("Pi 进程已退出")
	case <-ctx.Done():
		return fmt.Errorf("Pi 思考强度请求未完成：%w", ctx.Err())
	}
}

func (p *piProc) Effort(ctx context.Context) (EffortState, error) {
	var result EffortState
	if err := p.call(ctx, "get_available_thinking_levels", nil, &result); err != nil {
		return result, err
	}
	var state struct {
		ThinkingLevel string `json:"thinkingLevel"`
		SessionFile   string `json:"sessionFile"`
		SessionID     string `json:"sessionId"`
		Model         struct {
			ID       string `json:"id"`
			Provider string `json:"provider"`
		} `json:"model"`
	}
	if err := p.call(ctx, "get_state", nil, &state); err != nil {
		return result, err
	}
	result.Level, result.SessionID = state.ThinkingLevel, state.SessionFile
	if result.SessionID == "" {
		result.SessionID = state.SessionID
	}
	result.Model = state.Model.ID
	if state.Model.Provider != "" && result.Model != "" {
		result.Model = state.Model.Provider + "/" + result.Model
	}
	if result.Level == "" || len(result.Levels) == 0 {
		return result, errors.New("Pi 未返回思考强度信息，请更新 Pi 后重试")
	}
	return result, nil
}

func (p *piProc) SetEffort(ctx context.Context, level string) (EffortState, error) {
	state, err := p.Effort(ctx)
	if err != nil {
		return state, err
	}
	if level == "default" {
		// 使用同一模型和工作目录读取 Pi 配置，避免把历史会话中的旧档位当作默认值。
		opt := p.opt
		opt.Model, opt.ResumeID, opt.Effort, opt.Approver, opt.SendCmd = state.Model, "", "", nil, nil
		opt.Command = append(append([]string{}, opt.Command...), "--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files")
		probe, err := (PiDriver{}).Start(ctx, opt)
		if err != nil {
			return state, fmt.Errorf("读取 Pi 默认强度失败：%w", err)
		}
		defer probe.Close()
		defaults, err := probe.(EffortController).Effort(ctx)
		if err != nil {
			return state, err
		}
		level = defaults.Level
	}
	if !slices.Contains(state.Levels, level) {
		return state, fmt.Errorf("当前模型不支持 %q，可用强度：%s", level, strings.Join(state.Levels, ", "))
	}
	if err := p.call(ctx, "set_thinking_level", map[string]any{"level": level}, nil); err != nil {
		return state, err
	}
	return p.Effort(ctx)
}

// SplitPiEffort 仅识别有效的旧式思考后缀，保留模型 ID 中其他冒号。
func SplitPiEffort(model string) (string, string) {
	i := strings.LastIndex(model, ":")
	if i > 0 && slices.Contains([]string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}, model[i+1:]) {
		return model[:i], model[i+1:]
	}
	return model, ""
}
