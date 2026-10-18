package session

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/ewkzcz/pocketdesk/server/internal/agent"
	"github.com/ewkzcz/pocketdesk/server/internal/store"
	"slices"
	"strconv"
	"strings"
	"time"
)

func historyPath(st agent.HistoryState) ([]agent.HistoryEntry, error) {
	byID := map[string]agent.HistoryEntry{}
	for _, e := range st.Entries {
		byID[e.ID] = e
	}
	seen := map[string]bool{}
	id := leaf(st)
	var path []agent.HistoryEntry
	for id != "" {
		if seen[id] {
			return nil, errors.New("Pi 历史父链存在循环")
		}
		seen[id] = true
		e, ok := byID[id]
		if !ok {
			return nil, errors.New("Pi 历史父节点缺失")
		}
		path = append(path, e)
		id = ""
		if e.ParentID != nil {
			id = *e.ParentID
		}
	}
	slices.Reverse(path)
	return path, nil
}
func messageText(raw json.RawMessage) (string, string, []map[string]any, map[string]any) {
	var msg map[string]any
	json.Unmarshal(raw, &msg)
	role, _ := msg["role"].(string)
	var text strings.Builder
	var blocks []map[string]any
	if s, ok := msg["content"].(string); ok {
		text.WriteString(s)
	}
	if content, ok := msg["content"].([]any); ok {
		for _, v := range content {
			b, ok := v.(map[string]any)
			if !ok {
				continue
			}
			blocks = append(blocks, b)
			if b["type"] == "text" {
				t, _ := b["text"].(string)
				text.WriteString(t)
			}
		}
	}
	return role, text.String(), blocks, msg
}
func historyDraft(st agent.HistoryState, target string) Input { return historyDrafts(st)[target] }

func historyDrafts(st agent.HistoryState) map[string]Input {
	drafts := map[string]Input{}
	pending := map[string]*Input{}
	for _, e := range st.Entries {
		var input *Input
		if e.ParentID != nil {
			input = pending[*e.ParentID]
		}
		if e.CustomType == "pocketdesk.input" {
			var in Input
			if json.Unmarshal(e.Data, &in) == nil {
				input = &in
			}
		}
		if e.Type == "message" {
			role, text, _, _ := messageText(e.Message)
			if role == "user" {
				if input != nil {
					drafts[e.ID] = *input
				} else {
					drafts[e.ID] = Input{Text: text}
				}
				input = nil
			}
		}
		pending[e.ID] = input
	}
	return drafts
}

// Render the canonical branch, not the append order. Stable negative event IDs
// are reserved for native history; transport cursors remain strictly positive.
func historyOutline(st agent.HistoryState) (HistoryView, error) {
	v := HistoryView{LeafID: leaf(st), Nodes: []HistoryNode{}, Events: []store.Event{}}
	path, err := historyPath(st)
	if err != nil {
		return v, err
	}
	drafts := historyDrafts(st)
	byID := map[string]agent.HistoryEntry{}
	active := map[string]bool{}
	for _, e := range path {
		if e.CustomType == "pocketdesk.position" {
			var d struct {
				OperationID string `json:"operationId"`
			}
			json.Unmarshal(e.Data, &d)
			if d.OperationID != "" {
				v.BranchID = d.OperationID
			}
		}
		active[e.ID] = true
	}
	for _, e := range st.Entries {
		byID[e.ID] = e
	}
	endpoint := func(e agent.HistoryEntry) string {
		cursor := e.ParentID
		seen := map[string]bool{}
		for cursor != nil && !seen[*cursor] {
			seen[*cursor] = true
			p, ok := byID[*cursor]
			if !ok {
				break
			}
			if p.Type == "message" || p.Type == "compaction" || p.Type == "branch_summary" {
				return p.ID
			}
			cursor = p.ParentID
		}
		return "root"
	}
	pendingTools := map[string]map[string]bool{}
	safe := map[string]bool{}
	for _, e := range st.Entries {
		pending := map[string]bool{}
		valid := e.ParentID == nil
		if e.ParentID != nil {
			if previous, ok := pendingTools[*e.ParentID]; ok {
				valid = true
				for id := range previous {
					pending[id] = true
				}
			}
		}
		role, _, blocks, msg := messageText(e.Message)
		if role == "assistant" {
			for _, b := range blocks {
				if b["type"] == "toolCall" {
					id, _ := b["id"].(string)
					pending[id] = true
				}
			}
		}
		if role == "toolResult" {
			id, _ := msg["toolCallId"].(string)
			delete(pending, id)
		}
		if valid {
			pendingTools[e.ID] = pending
		}
		safe[e.ID] = valid && len(pending) == 0
	}
	anchor := "root"
	for i := len(path) - 1; i >= 0; i-- {
		e := path[i]
		if e.Type == "message" || e.Type == "compaction" || e.Type == "branch_summary" {
			anchor = e.ID
			break
		}
	}
	positions := map[string]string{}
	for _, e := range st.Entries {
		if e.CustomType == "pocketdesk.position" {
			positions[endpoint(e)] = e.ID
		}
	}
	for _, e := range st.Entries {
		role, text, blocks, _ := messageText(e.Message)
		mode := ""
		if e.Type == "message" && role == "user" {
			text = drafts[e.ID].Text
			mode = "edit"
		}
		if e.Type == "message" && role == "assistant" {
			safe := true
			for _, b := range blocks {
				if b["type"] == "toolCall" {
					safe = false
				}
			}
			if safe {
				mode = "continue"
			}
		}
		if e.CustomType == "pocketdesk.position" {
			if positions[endpoint(e)] != e.ID {
				continue
			}
			role = "branch"
			mode = "continue"
			text = "保存的分支位置"
			cursor := e.ParentID
			visited := map[string]bool{}
			for cursor != nil && !visited[*cursor] {
				visited[*cursor] = true
				ancestor, ok := byID[*cursor]
				if !ok {
					break
				}
				r, t, _, _ := messageText(ancestor.Message)
				if r == "user" && t != "" {
					text = "分支 · " + drafts[ancestor.ID].Text
					break
				}
				cursor = ancestor.ParentID
			}
		}
		if e.Type == "compaction" || e.Type == "branch_summary" {
			role = "summary"
			mode = "continue"
			text = e.Summary
		}
		if mode != "" && safe[e.ID] {
			v.Nodes = append(v.Nodes, HistoryNode{Here: e.ID == anchor || role == "branch" && endpoint(e) == anchor, ID: e.ID, ParentID: e.ParentID, Role: role, Text: agent.Truncate(text, 240), At: e.Timestamp, Mode: mode, Current: active[e.ID]})
		}
	}
	v.Tree = historyTurns(st, v.Nodes)
	return v, nil
}

func (m *Manager) historyView(ctx context.Context, rt *runtime, st agent.HistoryState) (HistoryView, error) {
	v, err := historyOutline(st)
	if err != nil {
		return v, err
	}
	v.Events, err = m.historyEvents(ctx, rt, st)
	return v, err
}

// Project one selected path. Preview and navigation validation do not need to
// construct the browse tree or scan unrelated checkpoints.
func (m *Manager) historyEvents(ctx context.Context, rt *runtime, st agent.HistoryState) ([]store.Event, error) {
	path, err := historyPath(st)
	if err != nil {
		return nil, err
	}
	drafts := historyDrafts(agent.HistoryState{Entries: path})
	indices := map[string]int{}
	for i, e := range st.Entries {
		indices[e.ID] = i + 1
	}
	events := []store.Event{}
	eventSeqs := map[string]int64{}
	for id, in := range drafts {
		if in.EventSeq > 0 && in.PocketDeskSessionID == rt.id {
			eventSeqs[id+":0"] = in.EventSeq
		}
	}

	for _, entry := range st.Entries {
		if entry.CustomType != "pocketdesk.bindings" {
			continue
		}
		var data struct {
			SessionID string `json:"pocketdeskSessionId"`
			Bindings  []struct {
				EntryID string `json:"entryId"`
				Seq     int64  `json:"seq"`
				Part    int    `json:"part"`
			} `json:"bindings"`
		}
		if json.Unmarshal(entry.Data, &data) == nil && data.SessionID == rt.id {
			for _, binding := range data.Bindings {
				if binding.Seq > 0 {
					eventSeqs[binding.EntryID+":"+strconv.Itoa(binding.Part)] = binding.Seq
				}
			}
		}
	}
	var input *Input
	add := func(e agent.HistoryEntry, part int, typ string, data map[string]any) {
		data["entryId"] = e.ID
		raw, _ := json.Marshal(data)
		at, _ := time.Parse(time.RFC3339Nano, e.Timestamp)
		seq := eventSeqs[e.ID+":"+strconv.Itoa(part)]
		if seq == 0 {
			seq = -int64(indices[e.ID]*10000 + part + 1)
		}
		events = append(events, store.Event{Session: rt.id, Seq: seq, Type: typ, Data: raw, CreatedAt: at.UnixMilli()})
	}
	for _, e := range path {
		if e.CustomType == "pocketdesk.input" {
			var in Input
			if json.Unmarshal(e.Data, &in) == nil {
				input = &in
			}
			continue
		}
		if e.CustomType == "pocketdesk.checkpoint" {
			var span struct {
				SessionID string `json:"pocketdeskSessionId"`
				Start     int64  `json:"start"`
				End       int64  `json:"end"`
			}
			json.Unmarshal(e.Data, &span)
			if span.Start > 0 && span.End >= span.Start && span.SessionID == rt.id {
				after := span.Start - 1
				for after < span.End {
					evs, err := m.d.Store.RawEventsAfter(ctx, rt.id, after, 500)
					if err != nil {
						return nil, err
					}
					if len(evs) == 0 {
						break
					}
					for _, event := range evs {
						after = event.Seq
						if event.Seq > span.End {
							break
						}
						switch event.Type {
						case "approval.request", "approval.done", "diff.summary", "file", "error":
							events = append(events, event)
						}
					}
				}
			}
			continue
		}
		if e.Type == "compaction" || e.Type == "branch_summary" {
			add(e, 0, "system", map[string]any{"text": "上下文摘要：" + e.Summary})
			continue
		}
		if e.Type == "custom_message" && (e.Display == nil || *e.Display) {
			raw, _ := json.Marshal(map[string]any{"content": e.Content})
			_, text, _, _ := messageText(raw)
			if text != "" {
				add(e, 0, "system", map[string]any{"text": text})
			}
			continue
		}
		if e.Type != "message" {
			continue
		}
		role, text, blocks, msg := messageText(e.Message)
		switch role {
		case "user":
			data := map[string]any{"text": text}
			if input != nil {
				data["text"] = input.Text
				data["attachments"] = input.Attachments
				var names []string
				for _, sk := range input.Skills {
					names = append(names, sk.Name)
				}
				data["skills"] = names
				input = nil
			}
			add(e, 0, "msg.user", data)
		case "assistant":
			if usage, ok := msg["usage"].(map[string]any); ok {
				cost := any(0)
				if c, ok := usage["cost"].(map[string]any); ok {
					cost = c["total"]
				}
				add(e, 9997, "usage", map[string]any{"inputTokens": usage["input"], "outputTokens": usage["output"], "costUsd": cost})
			}
			for i, b := range blocks {
				switch b["type"] {
				case "thinking":
					add(e, i+1, "thinking", map[string]any{"id": e.ID + "-t", "text": b["thinking"], "done": true})
				case "toolCall":
					name, _ := b["name"].(string)
					args, _ := b["arguments"].(map[string]any)
					add(e, i+1, "tool.start", map[string]any{"id": b["id"], "name": name, "kind": agent.PiToolKind(name), "summary": agent.PiSummary(name, args), "input": args})
				}
			}
			if text != "" {
				add(e, 0, "msg.done", map[string]any{"id": e.ID, "text": text})
			}
			if errorText, ok := msg["errorMessage"].(string); ok && errorText != "" {
				add(e, 9998, "error", map[string]any{"message": errorText})
			}
		case "bashExecution":
			add(e, 0, "tool.start", map[string]any{"id": e.ID, "name": "bash", "kind": "command", "summary": msg["command"], "input": map[string]any{"command": msg["command"]}})
			output, _ := msg["output"].(string)
			code, _ := msg["exitCode"].(float64)
			add(e, 1, "tool.end", map[string]any{"id": e.ID, "output": agent.Truncate(output, 8000), "isError": code != 0})
		case "toolResult":
			add(e, 0, "tool.end", map[string]any{"id": msg["toolCallId"], "output": agent.Truncate(text, 8000), "isError": msg["isError"]})
		}
	}
	return events, nil
}
