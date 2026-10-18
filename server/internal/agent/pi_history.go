package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

type HistoryEntry struct {
	ID         string          `json:"id"`
	ParentID   *string         `json:"parentId"`
	Type       string          `json:"type"`
	Timestamp  string          `json:"timestamp"`
	CustomType string          `json:"customType,omitempty"`
	Data       json.RawMessage `json:"data,omitempty"`
	Message    json.RawMessage `json:"message,omitempty"`
	Summary    string          `json:"summary,omitempty"`
	Content    json.RawMessage `json:"content,omitempty"`
	Display    *bool           `json:"display,omitempty"`
}
type HistoryState struct {
	Entries     []HistoryEntry `json:"entries"`
	LeafID      *string        `json:"leafId"`
	SessionFile string         `json:"sessionFile"`
	Cancelled   bool           `json:"cancelled"`
}
type HistoryController interface {
	History(context.Context, map[string]any) (HistoryState, error)
}

func (p *piProc) resolveHistory(line []byte) bool {
	var ack piResponse
	if json.Unmarshal(line, &ack) == nil && ack.Type == "response" && strings.HasPrefix(ack.ID, "pd-history-ack-") {
		if !ack.Success {
			ack.ID = strings.TrimPrefix(ack.ID, "pd-history-ack-")
			p.rmu.Lock()
			ch := p.pending[ack.ID]
			p.rmu.Unlock()
			if ch != nil {
				select {
				case ch <- ack:
				default:
				}
			}
		}
		return true
	}

	var event struct {
		Type    string `json:"type"`
		Method  string `json:"method"`
		Message string `json:"message"`
	}
	if json.Unmarshal(line, &event) != nil || event.Type != "extension_ui_request" || event.Method != "notify" || !strings.HasPrefix(event.Message, "pocketdesk:history ") {
		return false
	}
	var r piResponse
	if json.Unmarshal([]byte(strings.TrimPrefix(event.Message, "pocketdesk:history ")), &r) != nil {
		return true
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

func (p *piProc) History(ctx context.Context, fields map[string]any) (HistoryState, error) {
	var state HistoryState
	// Never send a control prompt unless the extension command is registered.
	var commands struct {
		Commands []struct {
			Name string `json:"name"`
		} `json:"commands"`
	}
	if err := p.call(ctx, "get_commands", nil, &commands); err != nil {
		return state, err
	}
	found := false
	for _, c := range commands.Commands {
		if c.Name == "pocketdesk-history" {
			found = true
			break
		}
	}
	if !found {
		return state, fmt.Errorf("当前 Pi 未加载历史扩展，请更新 Pi 后重试: %w", ErrUnsupported)
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	p.rmu.Lock()
	p.nextID++
	id := fmt.Sprintf("pd-history-%d", p.nextID)
	ch := make(chan piResponse, 1)
	p.pending[id] = ch
	p.rmu.Unlock()
	defer func() { p.rmu.Lock(); delete(p.pending, id); p.rmu.Unlock() }()
	fields["id"] = id
	payload, err := json.Marshal(fields)
	if err != nil {
		return state, err
	}
	// The RPC acceptance response is deliberately distinct from completion.
	if err = p.writeJSON(map[string]any{"type": "prompt", "id": "pd-history-ack-" + id, "message": "/pocketdesk-history " + string(payload)}); err != nil {
		return state, err
	}
	select {
	case r := <-ch:
		if !r.Success {
			if strings.Contains(r.Error, "当前 Pi 不支持历史导航") {
				return state, fmt.Errorf("%s: %w", r.Error, ErrUnsupported)
			}
			return state, errors.New(r.Error)
		}
		err = json.Unmarshal(r.Data, &state)
		return state, err
	case <-p.Done():
		return state, errors.New("Pi 进程已退出，历史操作结果需要重新确认")
	case <-ctx.Done():
		return state, fmt.Errorf("Pi 历史请求未完成: %w", ctx.Err())
	}
}
