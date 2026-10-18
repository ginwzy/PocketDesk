package httpapi

import (
	"github.com/ewkzcz/pocketdesk/server/internal/session"
	"net/http"
	"strconv"
)

func (s *Server) sessionHistory(w http.ResponseWriter, r *http.Request) {
	view, err := s.Sessions.History(r.Context(), r.PathValue("id"))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	view.Events = nil
	writeJSON(w, 200, view)
}
func (s *Server) navigateHistory(w http.ResponseWriter, r *http.Request) {
	var in session.HistoryNavigation
	if err := readJSON(r, &in); err != nil {
		writeErr(w, r, err)
		return
	}
	view, err := s.Sessions.NavigateHistory(r.Context(), r.PathValue("id"), in)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	s.audit(r, "session.history.navigate", map[string]any{"session": r.PathValue("id"), "target": in.TargetID, "operationId": in.OperationID, "cancelled": view.Cancelled})
	view.Events = nil
	writeJSON(w, 200, view)
}
func (s *Server) historyOperation(w http.ResponseWriter, r *http.Request) {
	op, err := s.Sessions.HistoryOperation(r.Context(), r.PathValue("id"), r.PathValue("operation"))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, 200, op)
}

func (s *Server) historyEntries(w http.ResponseWriter, r *http.Request) {
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	query := session.HistoryQuery{Offset: offset, Limit: limit}
	if r.URL.Query().Has("before") {
		before, err := strconv.Atoi(r.URL.Query().Get("before"))
		if err != nil || before < -1 {
			writeErr(w, r, errf(400, "bad_history_cursor", "历史分页位置无效"))
			return
		}
		query.Before = &before
	}
	page, err := s.Sessions.HistoryEntries(r.Context(), r.PathValue("id"), r.URL.Query().Get("targetId"), query)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, 200, page)
}
