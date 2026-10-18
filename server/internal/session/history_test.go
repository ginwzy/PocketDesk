package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ewkzcz/pocketdesk/server/internal/agent"
	"github.com/ewkzcz/pocketdesk/server/internal/store"
)

// Real Pi process, isolated profile and a local deterministic provider. Covers the
// protocol, durable session tree, Go manager, event projection and operation log.
func TestPiHistoryIntegration(t *testing.T) {
	if os.Getenv("PI_HISTORY_INTEGRATION") != "1" {
		t.Skip("PI_HISTORY_INTEGRATION=1 enables the real Pi workflow")
	}
	pi, err := agent.LookPath("pi")
	if err != nil {
		t.Fatal(err)
	}
	f := newFixture(t)
	ctx := context.Background()
	profile := t.TempDir()
	requests := make(chan map[string]any, 4)
	var providerCalls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		requests <- body
		w.Header().Set("Content-Type", "text/event-stream")
		if providerCalls.Add(1) == 1 {
			args, _ := json.Marshal(map[string]string{"path": filepath.Join(f.root, "untouched.txt")})
			chunk := map[string]any{"id": "fixture", "object": "chat.completion.chunk", "choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": "call-fixture-read", "type": "function", "function": map[string]any{"name": "read", "arguments": string(args)}}}}, "finish_reason": nil}}}
			raw, _ := json.Marshal(chunk)
			fmt.Fprintf(w, "data: %s\n\n", raw)
			fmt.Fprint(w, "data: {\"id\":\"fixture\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n")
			return
		}
		fmt.Fprint(w, "data: {\"id\":\"fixture\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"new branch reply\"},\"finish_reason\":null}]}\n\n")
		fmt.Fprint(w, "data: {\"id\":\"fixture\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":3,\"total_tokens\":8}}\n\ndata: [DONE]\n\n")
	}))
	defer provider.Close()
	settings := `{"defaultProvider":"fixture","defaultModel":"test","defaultThinkingLevel":"off"}`
	models := `{"providers":{"fixture":{"baseUrl":"http://127.0.0.1:1/v1","api":"openai-completions","apiKey":"unused","models":[{"id":"test","name":"test","reasoning":false,"input":["text"],"contextWindow":32000,"maxTokens":4096}]}}}`
	models = strings.Replace(models, "http://127.0.0.1:1", provider.URL, 1)
	for name, body := range map[string]string{"settings.json": settings, "models.json": models} {
		if err = os.WriteFile(filepath.Join(profile, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	f.cfg.Agents["pi"] = []string{"/usr/bin/env", "PI_CODING_AGENT_DIR=" + profile, pi, "--no-extensions", "--no-skills", "--no-context-files"}
	cancelExt := filepath.Join(profile, "cancel.ts")
	if err = os.WriteFile(cancelExt, []byte(`export default function(pi) { pi.on("session_before_tree", async (event) => { if(event.preparation.targetId === "a2") return { cancel: true }; }); }`), 0600); err != nil {
		t.Fatal(err)
	}
	f.cfg.Agents["pi"] = append(f.cfg.Agents["pi"], "-e", cancelExt)
	unchanged := filepath.Join(f.root, "untouched.txt")
	os.WriteFile(unchanged, []byte("files are not rewound"), 0600)
	f.m.d.Registry = agent.NewRegistry(agent.PiDriver{})
	file := filepath.Join(t.TempDir(), "fixture.jsonl")
	entries := []map[string]any{{"type": "session", "version": 3, "id": "history-fixture", "timestamp": "2026-01-01T00:00:00Z", "cwd": f.root}}
	parent := any(nil)
	for _, message := range []struct{ id, role, text string }{{"u1", "user", "first"}, {"a1", "assistant", "first reply"}, {"u2", "user", "same"}, {"a2", "assistant", "second reply"}, {"u3", "user", "same"}, {"a3", "assistant", "third reply"}} {
		msg := map[string]any{"role": message.role, "content": []any{map[string]any{"type": "text", "text": message.text}}, "timestamp": 1}
		if message.role == "assistant" {
			msg["api"] = "openai-completions"
			msg["provider"] = "fixture"
			msg["model"] = "test"
			msg["stopReason"] = "stop"
			msg["usage"] = map[string]any{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0, "cost": map[string]int{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}
		}
		entries = append(entries, map[string]any{"type": "message", "id": message.id, "parentId": parent, "timestamp": "2026-01-01T00:00:00Z", "message": msg})
		parent = message.id
	}
	var data strings.Builder
	for _, e := range entries {
		b, _ := json.Marshal(e)
		data.Write(b)
		data.WriteByte('\n')
	}
	if err = os.WriteFile(file, []byte(data.String()), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := f.m.Create(ctx, "pi", "w1", ".", "fixture/test")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.st.UpdateSession(ctx, s.ID, store.SessionPatch{AgentSessionID: &file}); err != nil {
		t.Fatal(err)
	}
	get := func() HistoryView {
		t.Helper()
		v, e := f.m.History(ctx, s.ID)
		if e != nil {
			t.Fatal(e)
		}
		return v
	}
	v := get()
	if historyMessages(v) != 6 {
		t.Fatalf("initial projection: %+v", v.Events)
	}
	nav := HistoryNavigation{OperationID: "edit-second", ExpectedLeaf: v.LeafID, TargetID: "u2", Mode: "edit"}
	v, err = f.m.NavigateHistory(ctx, s.ID, nav)
	if err != nil {
		t.Fatal(err)
	}
	if historyMessages(v) != 2 || v.Draft == nil || v.Draft.Text != "same" {
		t.Fatalf("edit did not exclude selected message: %+v", v)
	}
	again, err := f.m.NavigateHistory(ctx, s.ID, nav)
	if err != nil || again.LeafID != v.LeafID {
		t.Fatalf("idempotency: %+v %v", again, err)
	}
	stale := ""
	if err = f.m.Send(ctx, s.ID, Input{Text: "must not send", ExpectedBranch: &stale}); !errors.Is(err, ErrHistoryConflict) {
		t.Fatalf("stale send accepted: %v", err)
	}
	// Read and replay through the same endpoint contract used by both clients.
	events, err := f.st.EventsAfter(ctx, s.ID, 0, 500)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) == 0 || events[0].Type != "history.reset" {
		t.Fatalf("snapshot missing: %+v", events)
	}
	deps := f.m.d
	f.m.Shutdown()
	f.m = New(deps)
	t.Cleanup(f.m.Shutdown)
	if err = f.m.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	v = get()
	if historyMessages(v) != 2 {
		t.Fatalf("restart restored wrong branch: %+v", v.Events)
	}
	v, err = f.m.NavigateHistory(ctx, s.ID, HistoryNavigation{OperationID: "restore-original", ExpectedLeaf: v.LeafID, TargetID: "a3", Mode: "continue"})
	if err != nil {
		t.Fatal(err)
	}
	if historyMessages(v) != 6 {
		t.Fatalf("original history lost: %+v", v.Events)
	}
	v, err = f.m.NavigateHistory(ctx, s.ID, HistoryNavigation{OperationID: "root", ExpectedLeaf: v.LeafID, TargetID: "u1", Mode: "edit"})
	if err != nil {
		t.Fatal(err)
	}
	if historyMessages(v) != 0 || v.Draft.Text != "first" {
		t.Fatalf("root navigation: %+v", v)
	}
	// Simulate process death after Pi committed, before the DB recorded completion.
	rt, _ := f.m.runtime(ctx, s.ID)
	rt.mu.Lock()
	c := rt.proc.(agent.HistoryController)
	n := HistoryNavigation{OperationID: "recover-pending", ExpectedLeaf: v.LeafID, TargetID: "a3", Mode: "continue"}
	raw, _ := json.Marshal(n)
	err = f.st.SaveHistoryOperation(ctx, s.ID, store.HistoryOperation{ID: n.OperationID, Request: raw, Status: "pending"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.History(ctx, map[string]any{"action": "navigate", "expectedLeaf": v.LeafID, "targetId": "a3", "mode": "continue", "operationId": n.OperationID})
	rt.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	deps = f.m.d
	f.m.Shutdown()
	f.m = New(deps)
	t.Cleanup(f.m.Shutdown)
	if err = f.m.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	v = get()
	if historyMessages(v) != 6 {
		t.Fatalf("pending operation recovered wrong projection: %+v", v)
	}
	op, err := f.m.HistoryOperation(ctx, s.ID, n.OperationID)
	if err != nil || op.Status != "done" {
		t.Fatalf("pending operation not reconciled: %+v %v", op, err)
	}
	v, err = f.m.NavigateHistory(ctx, s.ID, HistoryNavigation{OperationID: "send-branch", ExpectedLeaf: v.LeafID, TargetID: "u2", Mode: "edit"})
	if err != nil {
		t.Fatal(err)
	}
	expected := v.BranchID
	if err = f.m.Send(ctx, s.ID, Input{Text: "different direction", ClientID: "branch-send", ExpectedBranch: &expected, Attachments: []string{"untouched.txt"}, Skills: []agent.SkillRef{{Name: "fixture-skill", Path: filepath.Join(profile, "SKILL.md")}}}); err != nil {
		t.Fatal(err)
	}
	select {
	case req := <-requests:
		body, _ := json.Marshal(req["messages"])
		text := string(body)
		if strings.Contains(text, "second reply") || strings.Contains(text, "third reply") || !strings.Contains(text, "first reply") || !strings.Contains(text, "different direction") {
			t.Fatalf("wrong model context: %s", text)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("provider was not called")
	}
	deadline := time.Now().Add(15 * time.Second)
	for f.m.State(s.ID) != StateIdle && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	v = get()
	if historyMessages(v) < 4 {
		t.Fatalf("new branch missing: %+v", v)
	}
	rawEvents, _ := f.st.RawEventsAfter(ctx, s.ID, 0, 5000)
	for _, e := range rawEvents {
		if e.Type == "system" && strings.Contains(string(e.Data), "历史保存位置未更新") {
			t.Fatalf("checkpoint failed: %s", e.Data)
		}
	}
	toolResult := false
	for _, event := range v.Events {
		if event.Type == "tool.end" && strings.Contains(string(event.Data), "files are not rewound") {
			toolResult = true
		}
	}
	if !toolResult {
		t.Fatal("real Pi read-tool result was lost from the branch projection")
	}
	var originalUser string
	for _, node := range v.Nodes {
		if node.Role == "user" && node.Text == "different direction" {
			originalUser = node.ID
		}
	}
	if originalUser == "" {
		t.Fatal("picker exposed the transformed prompt instead of original input")
	}
	v, err = f.m.NavigateHistory(ctx, s.ID, HistoryNavigation{OperationID: "restore-raw-input", ExpectedLeaf: v.LeafID, TargetID: originalUser, Mode: "edit"})
	if err != nil {
		t.Fatal(err)
	}
	if v.Draft == nil || v.Draft.Text != "different direction" || len(v.Draft.Attachments) != 1 || v.Draft.Attachments[0] != "untouched.txt" || len(v.Draft.Skills) != 1 || v.Draft.Skills[0].Name != "fixture-skill" {
		t.Fatalf("original input was not restored: %+v", v.Draft)
	}
	before := v.LeafID
	preview, err := f.m.HistoryEntries(ctx, s.ID, "a3", HistoryQuery{Limit: 2})
	if err != nil || len(preview.Events) != 2 || preview.NextOffset != 2 || preview.TargetText != "third reply" {
		t.Fatalf("preview pagination: %+v %v", preview, err)
	}
	full, e := f.m.HistoryEntries(ctx, s.ID, "a3", HistoryQuery{Limit: 200})
	if e != nil {
		t.Fatal(e)
	}
	cursor := -1
	var collected []store.Event
	for {
		page, e := f.m.HistoryEntries(ctx, s.ID, "a3", HistoryQuery{Before: &cursor, Limit: 2})
		if e != nil {
			t.Fatal(e)
		}
		if len(page.Events) > 2 || cursor >= 0 && page.Before >= cursor {
			t.Fatalf("invalid backwards page: %+v", page)
		}
		collected = append(page.Events, collected...)
		cursor = page.Before
		if cursor == 0 {
			break
		}
	}
	want, _ := json.Marshal(full.Events)
	got, _ := json.Marshal(collected)
	if string(want) != string(got) {
		t.Fatal("backwards preview omitted or duplicated events")
	}
	if after := get(); after.LeafID != before {
		t.Fatal("preview mutated the active branch")
	}
	cancelled, err := f.m.NavigateHistory(ctx, s.ID, HistoryNavigation{OperationID: "cancelled", ExpectedLeaf: before, TargetID: "a2", Mode: "continue"})
	if err != nil || !cancelled.Cancelled || historyMessages(cancelled) != historyMessages(v) {
		t.Fatalf("extension cancellation: %+v %v", cancelled, err)
	}
	v = get()
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, target := range []string{"a1", "a3"} {
		wg.Add(1)
		go func(target string) {
			defer wg.Done()
			_, e := f.m.NavigateHistory(ctx, s.ID, HistoryNavigation{OperationID: "race-" + target, ExpectedLeaf: v.LeafID, TargetID: target, Mode: "continue"})
			results <- e
		}(target)
	}
	wg.Wait()
	close(results)
	successes, conflicts := 0, 0
	for e := range results {
		if e == nil {
			successes++
		} else if errors.Is(e, ErrHistoryConflict) {
			conflicts++
		} else {
			t.Fatal(e)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("race result: successes=%d conflicts=%d", successes, conflicts)
	}
	rt, _ = f.m.runtime(ctx, s.ID)
	for _, busy := range []string{StateRunning, StateAwaiting, StateInterrupted} {
		rt.mu.Lock()
		rt.state = busy
		rt.mu.Unlock()
		if _, e := f.m.History(ctx, s.ID); !errors.Is(e, ErrBusy) {
			t.Fatalf("busy history accepted: %s %v", busy, e)
		}
	}
	rt.mu.Lock()
	rt.state = StateIdle
	rt.historyBlocked = true
	rt.last = &Input{Text: "must not retry into an uncertain branch"}
	rt.mu.Unlock()
	if e := f.m.Retry(ctx, s.ID); !errors.Is(e, ErrHistoryPending) {
		t.Fatalf("pending history allowed retry: %v", e)
	}
	if _, e := f.m.Effort(ctx, s.ID, nil); !errors.Is(e, ErrHistoryPending) {
		t.Fatalf("pending history allowed effort operation: %v", e)
	}
	model := "fixture/test"
	if _, e := f.m.Update(ctx, s.ID, Patch{Model: &model}); !errors.Is(e, ErrHistoryPending) {
		t.Fatalf("pending history allowed model switch: %v", e)
	}
	rt.mu.Lock()
	rt.historyBlocked = false
	rt.last = nil
	rt.mu.Unlock()
	if data, err := os.ReadFile(unchanged); err != nil || string(data) != "files are not rewound" {
		t.Fatalf("navigation changed a file: %s %v", data, err)
	}
	// Archiving transport events must not remove branch concurrency protection.
	if _, err = f.st.Maintain(ctx, t.TempDir(), store.RetentionPolicy{EventMaxAge: -time.Hour, EventMaxPerSession: 1, AuditMaxAge: time.Hour}); err != nil {
		t.Fatal(err)
	}
	deps = f.m.d
	f.m.Shutdown()
	f.m = New(deps)
	t.Cleanup(f.m.Shutdown)
	if err = f.m.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	if err = f.m.Send(ctx, s.ID, Input{Text: "must not send after archival", ExpectedBranch: &stale}); !errors.Is(err, ErrHistoryConflict) {
		t.Fatalf("archival lost branch guard: %v", err)
	}
	// A session stopped immediately after a user entry must be restorable AT
	// that entry, rather than silently applying edit-before semantics.
	v = get()
	rt, _ = f.m.runtime(ctx, s.ID)
	rt.mu.Lock()
	native, e := rt.proc.(agent.HistoryController).History(ctx, map[string]any{"action": "read"})
	rt.mu.Unlock()
	if e != nil {
		t.Fatal(e)
	}
	deps = f.m.d
	f.m.Shutdown()
	pending := map[string]any{"type": "message", "id": "pending-user", "parentId": native.LeafID, "timestamp": "2026-01-01T00:00:00Z", "message": map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "unfinished user prompt"}}, "timestamp": 1}}
	raw, _ = json.Marshal(pending)
	fh, e := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0600)
	if e != nil {
		t.Fatal(e)
	}
	fh.Write(append(raw, '\n'))
	fh.Close()
	f.m = New(deps)
	t.Cleanup(f.m.Shutdown)
	v = get()
	v, err = f.m.NavigateHistory(ctx, s.ID, HistoryNavigation{OperationID: "leave-user-leaf", ExpectedLeaf: v.LeafID, TargetID: "u1", Mode: "edit"})
	if err != nil {
		t.Fatal(err)
	}
	var savedUser string
	for _, node := range v.Nodes {
		if node.Role == "branch" && strings.Contains(node.Text, "unfinished user prompt") {
			savedUser = node.ID
		}
	}
	if savedUser == "" {
		t.Fatal("unfinished user leaf has no saved branch position")
	}
	v, err = f.m.NavigateHistory(ctx, s.ID, HistoryNavigation{OperationID: "restore-user-leaf", ExpectedLeaf: v.LeafID, TargetID: savedUser, Mode: "continue"})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, event := range v.Events {
		if event.Type == "msg.user" && strings.Contains(string(event.Data), "unfinished user prompt") {
			found = true
		}
	}
	if !found {
		t.Fatal("restoring branch dropped its last user message")
	}
	stored, err := f.st.Session(ctx, s.ID)
	if err != nil || stored.AgentSessionID != file {
		t.Fatalf("navigation created a different session file: %+v %v", stored, err)
	}
	snapshotBefore, err := f.st.LatestHistory(ctx, s.ID)
	if err != nil {
		t.Fatal(err)
	}
	deps = f.m.d
	f.m.Shutdown()
	if err = os.Rename(file, file+".saved"); err != nil {
		t.Fatal(err)
	}
	f.m = New(deps)
	t.Cleanup(f.m.Shutdown)
	if _, e := f.m.History(ctx, s.ID); e == nil || !strings.Contains(e.Error(), "会话文件不可用") {
		t.Fatalf("missing session silently opened a new history: %v", e)
	}
	branch := v.BranchID
	if e := f.m.Send(ctx, s.ID, Input{Text: "must not send without history", ExpectedBranch: &branch}); e == nil || !strings.Contains(e.Error(), "会话文件不可用") {
		t.Fatalf("missing session allowed a context-free send: %v", e)
	}
	snapshotAfter, err := f.st.LatestHistory(ctx, s.ID)
	if err != nil || string(snapshotAfter.Data) != string(snapshotBefore.Data) {
		t.Fatal("missing session erased the cached conversation")
	}
	t.Log("real Pi: navigation, model context, restart, interrupted commit, concurrency, cancellation, preview, busy guard and archival passed")
}

func historyMessages(v HistoryView) int {
	n := 0
	for _, e := range v.Events {
		if e.Type == "msg.user" || e.Type == "msg.done" {
			n++
		}
	}
	return n
}
