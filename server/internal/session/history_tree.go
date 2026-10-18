package session

import "github.com/ewkzcz/pocketdesk/server/internal/agent"

// HistoryTurn groups navigable positions by user request. Hidden Pi metadata
// is traversed, never displayed as a branch of its own.
type HistoryTurn struct {
	LatestText string        `json:"latestText"`
	LatestAt   string        `json:"latestAt"`
	ID         string        `json:"id"`
	ParentID   string        `json:"parentId"`
	Text       string        `json:"text"`
	At         string        `json:"timestamp"`
	Current    bool          `json:"current"`
	Here       bool          `json:"here"`
	User       *HistoryNode  `json:"user,omitempty"`
	Replies    []HistoryNode `json:"replies"`
	End        *HistoryNode  `json:"end,omitempty"`
}

func historyTurns(st agent.HistoryState, nodes []HistoryNode) []HistoryTurn {
	turns := []HistoryTurn{{ID: "root", Text: "对话起点", Current: true, Replies: []HistoryNode{}}}
	owners := map[string]int{}
	latest := map[int]int{0: -1}
	parents := map[int]int{}
	byID := map[string]HistoryNode{}
	for _, n := range nodes {
		byID[n.ID] = n
	}
	current := 0
	// Pi entries are append-only: a parent always precedes its children.
	for index, entry := range st.Entries {
		owner := 0
		if entry.ParentID != nil {
			owner = owners[*entry.ParentID]
		}
		node, visible := byID[entry.ID]
		if visible && node.Role == "user" {
			parentIndex := owner
			parent := turns[owner].ID
			owner = len(turns)
			parents[owner] = parentIndex
			turns = append(turns, HistoryTurn{ID: node.ID, ParentID: parent, Text: node.Text, At: node.At, LatestText: node.Text, LatestAt: node.At, Current: node.Current, User: &node, Replies: []HistoryNode{}})
			if node.Current {
				current = owner
			}
		}
		owners[entry.ID] = owner
		if visible && node.Role != "branch" {
			latest[owner] = index
			turns[owner].LatestAt = node.At
		}
		if !visible || node.Role == "user" {
			continue
		}
		turn := &turns[owner]
		if node.Role != "branch" {
			turn.Replies = append(turn.Replies, node)
		}
		// Prefer the actual active position over a later-created abandoned reply.
		if turn.End == nil || node.Current || !turn.End.Current {
			turn.End = &node
		}
	}
	for i := len(turns) - 1; i > 0; i-- {
		p := parents[i]
		if latest[i] > latest[p] {
			latest[p] = latest[i]
			turns[p].LatestText = turns[i].LatestText
			turns[p].LatestAt = turns[i].LatestAt
		}
	}
	turns[current].Here = true
	return turns
}
