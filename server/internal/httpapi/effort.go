package httpapi

import (
	"errors"
	"net/http"

	"github.com/ewkzcz/pocketdesk/server/internal/session"
)

func (s *Server) sessionEffort(w http.ResponseWriter, r *http.Request) {
	var level *string
	if r.Method == http.MethodPut {
		var body struct {
			Level *string `json:"level"`
		}
		if err := readJSON(r, &body); err != nil {
			writeErr(w, r, err)
			return
		}
		if body.Level == nil {
			writeErr(w, r, errf(400, "bad_effort", "请指定思考强度，或使用 default 恢复默认"))
			return
		}
		level = body.Level
	}
	info, err := s.Sessions.Effort(r.Context(), r.PathValue("id"), level)
	if err != nil {
		var effortErr *session.EffortError
		if errors.As(err, &effortErr) {
			err = errf(http.StatusBadRequest, "effort_failed", effortErr.Error())
		}
		writeErr(w, r, err)
		return
	}
	if level != nil {
		s.audit(r, "session.effort", map[string]any{"session": info.Session.ID, "setting": *level, "actual": info.Level})
	}
	writeJSON(w, 200, info)
}
