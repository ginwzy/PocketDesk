package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/ewkzcz/pocketdesk/server/internal/agent"
	"github.com/ewkzcz/pocketdesk/server/internal/store"
)

var ErrHistoryPending = errors.New("历史操作尚待确认，请打开历史分支完成恢复后重试")

var ErrHistoryFileUnavailable = errors.New("Pi 会话文件不可用，已保留现有聊天记录；请恢复原会话文件后重试")
var ErrHistoryImageUnavailable = errors.New("这条旧消息的原生图片没有可恢复的附件路径，请从前一条回复继续并重新附图")

var ErrHistoryConflict = errors.New("会话分支已变化，请刷新后重试；输入内容已保留")

type HistoryNode struct {
	Here     bool    `json:"here"`
	ID       string  `json:"id"`
	ParentID *string `json:"parentId"`
	Role     string  `json:"role"`
	Text     string  `json:"text"`
	At       string  `json:"timestamp"`
	Mode     string  `json:"mode"`
	Current  bool    `json:"current"`
}
type HistoryView struct {
	Tree          []HistoryTurn `json:"tree,omitempty"`
	DraftWarnings []string      `json:"draftWarnings,omitempty"`
	BranchID      string        `json:"branchId"`
	LeafID        string        `json:"leafId"`
	Nodes         []HistoryNode `json:"nodes"`
	Events        []store.Event `json:"events"`
	LastSeq       int64         `json:"lastSeq"`
	Cancelled     bool          `json:"cancelled"`
	Draft         *Input        `json:"draft,omitempty"`
	OperationID   string        `json:"operationId,omitempty"`
}
type HistoryNavigation struct {
	OperationID  string `json:"operationId"`
	ExpectedLeaf string `json:"expectedLeaf"`
	TargetID     string `json:"targetId"`
	Mode         string `json:"mode"`
}

func leaf(s agent.HistoryState) string {
	if s.LeafID == nil {
		return ""
	}
	return *s.LeafID
}

// Called with the runtime lock; RPC completions are resolved in the driver,
// independently of the event pump. Only idle processes can reach this path.
func (m *Manager) historyProc(ctx context.Context, rt *runtime) (agent.HistoryController, error) {
	if !m.d.Config().Features.Agents {
		return nil, ErrDisabled
	}
	if m.closed.Load() {
		return nil, ErrClosed
	}
	if rt.sess.Kind != agent.KindPi {
		return nil, agent.ErrUnsupported
	}
	if rt.state != StateIdle && rt.state != StateError || len(rt.queue) > 0 || rt.turn != nil {
		return nil, ErrBusy
	}
	if err := checkHistoryFile(rt); err != nil {
		return nil, err
	}
	if rt.proc == nil {
		cwd, err := m.absCwd(ctx, rt.sess)
		if err != nil {
			return nil, err
		}
		rt.proc, err = m.startProc(ctx, rt, rt.sess.Kind, cwd, rt.sess.AgentSessionID, rt.sess.Model)
		if err != nil {
			return nil, err
		}
	}
	c, ok := rt.proc.(agent.HistoryController)
	if !ok {
		return nil, agent.ErrUnsupported
	}
	return c, nil
}
func (m *Manager) readHistory(ctx context.Context, rt *runtime, c agent.HistoryController) (agent.HistoryState, error) {
	st, err := c.History(ctx, map[string]any{"action": "read"})
	if err != nil {
		return st, err
	}
	for _, entry := range st.Entries {
		role, _, _, _ := messageText(entry.Message)
		if role == "user" || role == "assistant" {
			rt.historyPersisted = true
			break
		}
	}
	if st.SessionFile != "" && rt.sess.AgentSessionID != st.SessionFile {
		s, e := m.d.Store.UpdateSession(ctx, rt.id, store.SessionPatch{AgentSessionID: &st.SessionFile})
		if e != nil {
			return st, e
		}
		rt.sess = s
	}
	return st, nil
}
func (m *Manager) History(ctx context.Context, id string) (HistoryView, error) {
	rt, err := m.runtime(ctx, id)
	if err != nil {
		return HistoryView{}, err
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	c, err := m.historyProc(ctx, rt)
	if err != nil {
		return HistoryView{}, err
	}
	st, err := m.readHistory(ctx, rt, c)
	if err != nil {
		return HistoryView{}, err
	}
	if err = m.reconcileHistory(ctx, rt, st); err != nil {
		return HistoryView{}, err
	}
	return m.publishHistory(ctx, rt, st)
}
func (m *Manager) NavigateHistory(ctx context.Context, id string, n HistoryNavigation) (HistoryView, error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 45*time.Second)
	defer cancel()
	rt, err := m.runtime(ctx, id)
	if err != nil {
		return HistoryView{}, err
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if n.OperationID == "" || len(n.OperationID) > 128 || n.TargetID == "" || (n.Mode != "edit" && n.Mode != "continue") {
		return HistoryView{}, errors.New("无效的历史操作")
	}
	c, err := m.historyProc(ctx, rt)
	if err != nil {
		return HistoryView{}, err
	}
	st, err := m.readHistory(ctx, rt, c)
	if err != nil {
		return HistoryView{}, err
	}
	if err = m.reconcileHistory(ctx, rt, st); err != nil {
		return HistoryView{}, err
	}
	old, err := m.d.Store.HistoryOperation(ctx, id, n.OperationID)
	if err == nil {
		var prev HistoryNavigation
		json.Unmarshal(old.Request, &prev)
		if prev != n {
			return HistoryView{}, errors.New("操作编号已经用于另一个请求")
		}
		var v HistoryView
		if len(old.Result) > 0 {
			err = json.Unmarshal(old.Result, &v)
			return v, err
		}
		return v, errors.New("历史操作尚未完成，请刷新后查询结果")
	}
	if !errors.Is(err, store.ErrNotFound) {
		return HistoryView{}, err
	}
	if leaf(st) != n.ExpectedLeaf {
		return HistoryView{}, ErrHistoryConflict
	}
	v, err := historyOutline(st)
	if err != nil {
		return v, err
	}
	valid := false
	for _, node := range v.Nodes {
		if node.ID == n.TargetID && node.Mode == n.Mode {
			valid = true
			break
		}
	}
	if !valid {
		return v, errors.New("该位置不是可恢复的完整对话节点")
	}
	var draft *Input
	if n.Mode == "edit" {
		d := historyDraft(st, n.TargetID)
		for _, e := range st.Entries {
			if e.ID == n.TargetID {
				_, _, blocks, _ := messageText(e.Message)
				for _, b := range blocks {
					if b["type"] == "image" && len(d.Attachments) == 0 {
						return v, ErrHistoryImageUnavailable
					}
				}
			}
		}
		draft = &d
	}
	raw, _ := json.Marshal(n)
	op := store.HistoryOperation{ID: n.OperationID, Request: raw, Status: "pending"}
	if err = m.d.Store.SaveHistoryOperation(ctx, id, op); err != nil {
		return v, err
	}
	rt.historyBlocked = true
	expected := any(n.ExpectedLeaf)
	if n.ExpectedLeaf == "" {
		expected = nil
	}
	next, err := c.History(ctx, map[string]any{"action": "navigate", "targetId": n.TargetID, "mode": n.Mode, "expectedLeaf": expected, "operationId": n.OperationID})
	if err != nil {
		slog.Warn("Pi 历史操作等待恢复", "session", id, "operation", n.OperationID, "err", err)
		old := rt.proc
		rt.proc = nil
		old.Close()
		<-old.Done()
		return HistoryView{}, fmt.Errorf("%w: %v", ErrHistoryPending, err)
	}
	if next.Cancelled {
		// Cancellation may still leave a harmless old-position marker.
		next, err = m.readHistory(ctx, rt, c)
		if err != nil {
			return v, err
		}
		v, err = m.publishHistory(ctx, rt, next)
		v.Cancelled = true
	} else {
		v, err = m.publishHistory(ctx, rt, next)
		v.Draft = draft
		v.DraftWarnings = m.historyDraftWarnings(ctx, rt, draft)
	}
	if err != nil {
		return v, err
	}
	v.OperationID = n.OperationID
	saved := v
	saved.Events = nil
	saved.Nodes = nil
	saved.Tree = nil
	op.Result, _ = json.Marshal(saved)
	op.Status = "done"
	if err = m.d.Store.SaveHistoryOperation(ctx, id, op); err != nil {
		return v, err
	}
	rt.historyBlocked = false
	if !v.Cancelled {
		rt.last = nil
		m.setState(ctx, rt, StateIdle)
	}
	return v, nil
}
func (m *Manager) HistoryOperation(ctx context.Context, id, op string) (store.HistoryOperation, error) {
	// A read reconciles an interrupted mutation before exposing its final result.
	if _, err := m.History(ctx, id); err != nil {
		return store.HistoryOperation{}, err
	}
	return m.d.Store.HistoryOperation(ctx, id, op)
}
func (m *Manager) reconcileHistory(ctx context.Context, rt *runtime, st agent.HistoryState) error {
	ops, err := m.d.Store.PendingHistoryOperations(ctx, rt.id)
	if err != nil {
		return err
	}
	if len(ops) > 0 {
		rt.last = nil
	}
	for _, op := range ops {
		var n HistoryNavigation
		if err = json.Unmarshal(op.Request, &n); err != nil {
			return err
		}
		completed := false
		for _, e := range st.Entries {
			if e.CustomType == "pocketdesk.position" {
				var d struct {
					OperationID string `json:"operationId"`
				}
				json.Unmarshal(e.Data, &d)
				if d.OperationID == op.ID {
					completed = true
					break
				}
			}
		}
		v, e := m.publishHistory(ctx, rt, st)
		if e != nil {
			return e
		}
		v.OperationID = op.ID
		v.Cancelled = !completed
		if completed && n.Mode == "edit" {
			d := historyDraft(st, n.TargetID)
			v.Draft = &d
			v.DraftWarnings = m.historyDraftWarnings(ctx, rt, &d)
		}
		saved := v
		saved.Events = nil
		saved.Nodes = nil
		saved.Tree = nil
		op.Result, _ = json.Marshal(saved)
		op.Status = "done"
		if err = m.d.Store.SaveHistoryOperation(ctx, rt.id, op); err != nil {
			return err
		}
	}
	rt.historyBlocked = false
	return nil
}
func (m *Manager) publishHistory(ctx context.Context, rt *runtime, st agent.HistoryState) (HistoryView, error) {
	v, err := m.historyView(ctx, rt, st)
	if err != nil {
		return v, err
	}
	old, e := m.d.Store.LatestHistory(ctx, rt.id)
	var prev HistoryView
	if e == nil {
		json.Unmarshal(old.Data, &prev)
	}
	if e != nil && !errors.Is(e, store.ErrNotFound) {
		return v, e
	}
	if e != nil || prev.LeafID != v.LeafID {
		data := map[string]any{"leafId": v.LeafID, "branchId": v.BranchID, "events": v.Events}
		if err = m.emit(ctx, rt.id, "history.reset", data); err != nil {
			return v, err
		}
	}
	if rt.historyPersisted {
		if err = m.d.Store.SaveHistoryPosition(ctx, rt.id, v.LeafID, v.BranchID); err != nil {
			return v, err
		}
	}
	rt.historyBranch = v.BranchID
	rt.historyEnabled = true
	s, err := m.d.Store.Session(ctx, rt.id)
	if err == nil {
		v.LastSeq = s.LastSeq
	}
	return v, err
}

// Bind live bubbles to native entries without duplicating the entire history on
// every turn. Full snapshots are only needed when browsing or changing branches.
func (m *Manager) bindHistory(ctx context.Context, rt *runtime, st agent.HistoryState, start int64) error {
	path, err := historyPath(st)
	if err != nil {
		return err
	}
	startAt := 0
	for i, e := range path {
		if e.CustomType == "pocketdesk.input" {
			startAt = i
		}
	}
	path = path[startAt:]
	var user string
	var assistants []string
	for _, entry := range path {
		if entry.CustomType == "pocketdesk.input" {
			user = ""
			assistants = nil
		}
		role, text, _, _ := messageText(entry.Message)
		if role == "user" {
			user = entry.ID
		}
		if role == "assistant" && text != "" {
			assistants = append(assistants, entry.ID)
		}
	}
	if user == "" {
		return nil
	}
	bindings := []map[string]any{{"seq": start, "entryId": user}}
	after := start
	next := 0
	firstSeq := map[string]int64{}
	toolSeq := map[string]int64{}
	for {
		events, err := m.d.Store.RawEventsAfter(ctx, rt.id, after, 500)
		if err != nil {
			return err
		}
		if len(events) == 0 {
			break
		}
		for _, e := range events {
			after = e.Seq
			var payload map[string]any
			json.Unmarshal(e.Data, &payload)
			id, _ := payload["id"].(string)
			if e.Type == "msg.delta" && firstSeq[id] == 0 {
				firstSeq[id] = e.Seq
			}
			if e.Type == "tool.start" {
				toolSeq[id] = e.Seq
			}
			if e.Type == "msg.done" && next < len(assistants) {
				var data map[string]any
				json.Unmarshal(e.Data, &data)
				seq := firstSeq[id]
				if seq == 0 {
					seq = e.Seq
				}
				bindings = append(bindings, map[string]any{"seq": seq, "messageId": data["id"], "entryId": assistants[next]})
				next++
			}
		}
		if len(events) < 500 {
			break
		}
	}
	for _, entry := range path {
		_, _, blocks, _ := messageText(entry.Message)
		for i, b := range blocks {
			if b["type"] == "toolCall" {
				id, _ := b["id"].(string)
				if seq := toolSeq[id]; seq > 0 {
					bindings = append(bindings, map[string]any{"seq": seq, "entryId": entry.ID, "part": i + 1})
				}
			}
		}
	}
	if controller, ok := rt.proc.(agent.HistoryController); ok {
		saved, err := controller.History(ctx, map[string]any{"action": "bindings", "input": map[string]any{"bindings": bindings, "pocketdeskSessionId": rt.id}})
		if err != nil {
			return err
		}
		st.LeafID = saved.LeafID
	}
	return m.emit(ctx, rt.id, "history.bind", map[string]any{"leafId": leaf(st), "branchId": rt.historyBranch, "bindings": bindings})
}

// Before is an exclusive event offset; -1 requests the tail. A nil Before
// keeps the original forward-offset protocol for already installed clients.
type HistoryQuery struct {
	Offset int
	Limit  int
	Before *int
}

type HistoryPage struct {
	Before      int           `json:"before"`
	InputNotice string        `json:"inputNotice,omitempty"`
	Events      []store.Event `json:"events"`
	Total       int           `json:"total"`
	NextOffset  int           `json:"nextOffset"`
	TargetText  string        `json:"targetText"`
	LeafID      string        `json:"leafId"`
}

// Preview a branch without changing Pi's active position. Offset belongs to
// this immutable target path, not to the transport event sequence.
func (m *Manager) HistoryEntries(ctx context.Context, id, target string, query HistoryQuery) (HistoryPage, error) {
	var page HistoryPage
	rt, err := m.runtime(ctx, id)
	if err != nil {
		return page, err
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	c, err := m.historyProc(ctx, rt)
	if err != nil {
		return page, err
	}
	st, err := m.readHistory(ctx, rt, c)
	if err != nil {
		return page, err
	}
	page.LeafID = leaf(st)
	if target != "" {
		found := false
		for _, e := range st.Entries {
			if e.ID == target {
				found = true
				role, text, _, _ := messageText(e.Message)
				page.TargetText = text
				if role == "user" {
					draft := historyDraft(st, target)
					page.TargetText = draft.Text
					if draft.EventSeq == 0 {
						page.InputNotice = "这条旧记录未保存原始输入，内容可能包含当时的预设指令或附件路径，请检查后再发送。"
					}
				}
				break
			}
		}
		if !found {
			return page, errors.New("历史节点不存在")
		}
		st.LeafID = &target
	}
	events, err := m.historyEvents(ctx, rt, st)
	if err != nil {
		return page, err
	}
	page.Total = len(events)
	limit := query.Limit
	if limit < 1 || limit > 200 {
		limit = 50
	}
	start := min(max(query.Offset, 0), page.Total)
	end := min(start+limit, page.Total)
	if query.Before != nil {
		end = page.Total
		if *query.Before >= 0 {
			end = min(*query.Before, page.Total)
		}
		start = max(0, end-limit)
	}
	page.Events = events[start:end]
	page.Before = start
	page.NextOffset = -1
	if end < page.Total {
		page.NextOffset = end
	}
	return page, nil
}

func (m *Manager) historyDraftWarnings(ctx context.Context, rt *runtime, draft *Input) []string {
	if draft == nil {
		return nil
	}
	cwd, err := m.absCwd(ctx, rt.sess)
	if err != nil {
		return []string{"工作目录不可用，请检查历史附件路径"}
	}
	var warnings []string
	for _, path := range draft.Attachments {
		absolute := path
		if !filepath.IsAbs(path) {
			absolute = filepath.Join(cwd, path)
		}
		if _, err := os.Stat(absolute); err != nil {
			warnings = append(warnings, "历史附件不可用："+path)
		}
	}
	return warnings
}

func checkHistoryFile(rt *runtime) error {
	if !rt.historyPersisted || rt.sess.AgentSessionID == "" {
		return nil
	}
	info, err := os.Stat(rt.sess.AgentSessionID)
	if err != nil || info.IsDir() || info.Size() == 0 {
		return ErrHistoryFileUnavailable
	}
	return nil
}
