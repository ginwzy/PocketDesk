package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

type HistoryOperation struct {
	ID      string          `json:"operationId"`
	Request json.RawMessage `json:"request"`
	Result  json.RawMessage `json:"result,omitempty"`
	Status  string          `json:"status"`
}

func (s *Store) HistoryOperation(ctx context.Context, sid, id string) (HistoryOperation, error) {
	o := HistoryOperation{ID: id}
	var request, result string
	err := s.db.QueryRowContext(ctx, `SELECT request,result,status FROM history_operations WHERE session_id=? AND id=?`, sid, id).Scan(&request, &result, &o.Status)
	if errors.Is(err, sql.ErrNoRows) {
		return o, ErrNotFound
	}
	o.Request = json.RawMessage(request)
	o.Result = json.RawMessage(result)
	return o, err
}
func (s *Store) SaveHistoryOperation(ctx context.Context, sid string, o HistoryOperation) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO history_operations(session_id,id,request,result,status) VALUES(?,?,?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET result=excluded.result,status=excluded.status`, sid, o.ID, string(o.Request), string(o.Result), o.Status)
	return err
}
func (s *Store) PendingHistoryOperations(ctx context.Context, sid string) ([]HistoryOperation, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,request FROM history_operations WHERE session_id=? AND status='pending'`, sid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []HistoryOperation
	for rows.Next() {
		var o HistoryOperation
		var r string
		if err = rows.Scan(&o.ID, &r); err != nil {
			return nil, err
		}
		o.Request = json.RawMessage(r)
		o.Status = "pending"
		out = append(out, o)
	}
	return out, rows.Err()
}
func (s *Store) LatestHistory(ctx context.Context, sid string) (Event, error) {
	var e Event
	var data string
	err := s.db.QueryRowContext(ctx, `SELECT session_id,seq,type,data,created_at FROM events WHERE session_id=? AND type='history.reset' ORDER BY seq DESC LIMIT 1`, sid).Scan(&e.Session, &e.Seq, &e.Type, &data, &e.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	e.Data = json.RawMessage(data)
	return e, err
}

func (s *Store) HistoryPosition(ctx context.Context, id string) (string, string, error) {
	var leaf, branch string
	err := s.db.QueryRowContext(ctx, `SELECT leaf_id,branch_id FROM history_state WHERE session_id=?`, id).Scan(&leaf, &branch)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return leaf, branch, err
}
func (s *Store) SaveHistoryPosition(ctx context.Context, id, leaf, branch string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO history_state(session_id,leaf_id,branch_id) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET leaf_id=excluded.leaf_id,branch_id=excluded.branch_id`, id, leaf, branch)
	return err
}
