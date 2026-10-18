package session

import (
	"github.com/ewkzcz/pocketdesk/server/internal/agent"
	"testing"
)

func TestHistoryTurnsPreserveForksThroughHiddenEntries(t *testing.T) {
	ptr := func(s string) *string { return &s }
	st := agent.HistoryState{Entries: []agent.HistoryEntry{
		{ID: "u1"}, {ID: "a1", ParentID: ptr("u1")},
		{ID: "metadata", ParentID: ptr("a1")},
		{ID: "u2", ParentID: ptr("metadata")}, {ID: "a2", ParentID: ptr("u2")},
		{ID: "bookmark", ParentID: ptr("a2")},
		{ID: "input", ParentID: ptr("a1")}, {ID: "u3", ParentID: ptr("input")},
		{ID: "a3", ParentID: ptr("u3")}, {ID: "current", ParentID: ptr("a3")},
	}}
	nodes := []HistoryNode{
		{ID: "u1", Role: "user", Text: "共同请求", Current: true}, {ID: "a1", Role: "assistant", Current: true},
		{ID: "u2", Role: "user", Text: "深色"}, {ID: "a2", Role: "assistant"}, {ID: "bookmark", Role: "branch"},
		{ID: "u3", Role: "user", Text: "浅色", Current: true}, {ID: "a3", Role: "assistant", Current: true}, {ID: "current", Role: "branch", Current: true, Here: true},
	}
	tree := historyTurns(st, nodes)
	if tree[1].LatestText != "浅色" || tree[2].LatestText != "深色" {
		t.Fatalf("collapsed branch summary lost: %+v", tree)
	}
	if len(tree) != 4 {
		t.Fatalf("metadata leaked into tree: %+v", tree)
	}
	if tree[1].ParentID != "root" || tree[2].ParentID != "u1" || tree[3].ParentID != "u1" {
		t.Fatalf("fork lost through metadata: %+v", tree)
	}
	if !tree[3].Here || tree[2].Current || tree[1].Here || tree[0].Here {
		t.Fatal("current route and current position were confused")
	}
	if len(tree[2].Replies) != 1 || tree[2].End.ID != "bookmark" || tree[3].End.ID != "current" {
		t.Fatal("saved positions must be actions inside a turn, not extra tree nodes")
	}
}

func TestHistoryTurnsRootAndUnfinishedUser(t *testing.T) {
	p := "u"
	st := agent.HistoryState{Entries: []agent.HistoryEntry{{ID: "u"}, {ID: "saved", ParentID: &p}, {ID: "root-position"}}}
	nodes := []HistoryNode{{ID: "u", Role: "user", Current: true}, {ID: "saved", Role: "branch", Current: true, Here: true}, {ID: "root-position", Role: "branch"}}
	tree := historyTurns(st, nodes)
	if !tree[1].Here || tree[1].End.ID != "saved" || tree[0].End.ID != "root-position" {
		t.Fatal("unfinished user or empty-root restore target lost")
	}
	for i := range nodes {
		nodes[i].Current = false
	}
	nodes[2].Current = true
	tree = historyTurns(st, nodes)
	if !tree[0].Here || tree[1].Here {
		t.Fatal("empty root must be the only current position")
	}
}
