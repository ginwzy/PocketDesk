package agent

import (
	"slices"
	"testing"
)

func TestPiArgsModelProvider(t *testing.T) {
	for _, tc := range []struct {
		model string
		args  []string
	}{
		{"OpenAI/gpt-6-astra", []string{"--provider", "OpenAI", "--model", "gpt-6-astra"}},
		{"openrouter/vendor/model", []string{"--provider", "openrouter", "--model", "vendor/model"}},
		{"gpt-6-astra", []string{"--model", "gpt-6-astra"}},
		{"", nil},
	} {
		t.Run(tc.model, func(t *testing.T) {
			want := append([]string{"pi", "--mode", "rpc"}, tc.args...)
			want = append(want, "--session", "existing.jsonl")
			got := PiArgs(Options{Command: []string{"pi"}, Model: tc.model, ResumeID: "existing.jsonl"})
			if !slices.Equal(got, want) {
				t.Fatalf("得到 %q，期望 %q", got, want)
			}
		})
	}
}

func TestPiStatePreservesProvider(t *testing.T) {
	p := &piParser{}
	evs := p.parse([]byte(`{"type":"response","command":"get_state","success":true,"data":{"sessionFile":"existing.jsonl","model":{"provider":"OpenAI","id":"gpt-6-astra"}}}`))
	if len(evs) != 1 || evs[0].Type != EvSessionID || evs[0].Data["model"] != "OpenAI/gpt-6-astra" {
		t.Fatalf("会话状态丢失供应商：%+v", evs)
	}
}
