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

func TestPiArgsEffort(t *testing.T) {
	args := PiArgs(Options{Model: "OpenAI/vendor/model", Effort: "high", ResumeID: "session.jsonl"})
	for _, pair := range [][]string{{"--provider", "OpenAI"}, {"--model", "vendor/model"}, {"--thinking", "high"}, {"--session", "session.jsonl"}} {
		i := slices.Index(args, pair[0])
		if i < 0 || i+1 >= len(args) || args[i+1] != pair[1] {
			t.Fatalf("参数丢失或混淆：%q，期望 %q", args, pair)
		}
	}
	if args := PiArgs(Options{Effort: "default"}); slices.Contains(args, "--thinking") {
		t.Fatalf("default 应从 Pi 配置读取，不能作为 CLI 档位：%q", args)
	}
}
