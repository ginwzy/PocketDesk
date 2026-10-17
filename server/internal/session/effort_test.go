package session

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/ewkzcz/pocketdesk/server/internal/agent"
	"github.com/ewkzcz/pocketdesk/server/internal/store"
)

func TestPiEffortMigration(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	s, err := f.m.Create(ctx, "pi", "w1", ".", "OpenAI/vendor/model:high")
	if err != nil || s.Model != "OpenAI/vendor/model" || s.Effort != "high" {
		t.Fatalf("旧式模型后缀未拆分：%+v %v", s, err)
	}
	model := "OpenAI/vendor/another"
	s, err = f.m.Update(ctx, s.ID, Patch{Model: &model})
	if err != nil || s.Effort != "high" {
		t.Fatalf("切换模型丢失强度：%+v %v", s, err)
	}
	legacy, override := "OpenAI/vendor/model:xhigh", "low"
	if _, err := f.st.UpdateSession(ctx, s.ID, store.SessionPatch{Model: &legacy, Effort: &override}); err != nil {
		t.Fatal(err)
	}
	if err := f.m.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	s, err = f.st.Session(ctx, s.ID)
	if err != nil || s.Model != "OpenAI/vendor/model" || s.Effort != "low" {
		t.Fatalf("迁移应保留显式覆盖及供应商：%+v %v", s, err)
	}
}

// 显式启用后通过本机真实 Pi RPC 验证；使用隔离配置，不发模型请求、不修改用户的 Pi 设置。
func TestPiEffortIntegration(t *testing.T) {
	if os.Getenv("PI_EFFORT_INTEGRATION") != "1" {
		t.Skip("设置 PI_EFFORT_INTEGRATION=1 运行真实 Pi 集成验证")
	}
	pi, err := agent.LookPath("pi")
	if err != nil {
		t.Fatal(err)
	}
	profile := t.TempDir()
	settings := `{"defaultProvider":"OpenAI","defaultModel":"gpt-6-astra","defaultThinkingLevel":"medium"}`
	models := `{"providers":{"OpenAI":{"baseUrl":"http://127.0.0.1:1/v1","api":"openai-completions","apiKey":"fixture-unused","models":[{"id":"gpt-6-astra","name":"Fixture Reasoning","reasoning":true,"input":["text"],"contextWindow":32000,"maxTokens":4096},{"id":"plain-model","name":"Fixture Plain","reasoning":false,"input":["text"],"contextWindow":32000,"maxTokens":4096}]}}}`
	for name, content := range map[string]string{"settings.json": settings, "models.json": models} {
		if err := os.WriteFile(filepath.Join(profile, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	f := newFixture(t)
	// 驱动使用缓存的登录环境，需在启动命令中明确覆盖配置目录。
	f.cfg.Agents["pi"] = []string{"/usr/bin/env", "PI_CODING_AGENT_DIR=" + profile, pi, "--no-extensions", "--no-mcp", "--no-context-files"}
	f.m.d.Registry = agent.NewRegistry(f.claude, agent.PiDriver{})
	ctx := context.Background()
	s, err := f.m.Create(ctx, "pi", "w1", ".", "OpenAI/gpt-6-astra:high")
	if err != nil {
		t.Fatal(err)
	}
	get := func() EffortInfo {
		t.Helper()
		info, err := f.m.Effort(ctx, s.ID, nil)
		if err != nil {
			t.Fatal(err)
		}
		return info
	}
	set := func(level string) EffortInfo {
		t.Helper()
		info, err := f.m.Effort(ctx, s.ID, &level)
		if err != nil {
			t.Fatal(err)
		}
		return info
	}
	info := get()
	if info.Level != "high" || info.Model != "OpenAI/gpt-6-astra" || !slices.Contains(info.Levels, "low") {
		t.Fatalf("真实 Pi 状态错误：%+v", info)
	}
	if info = set("low"); info.Level != "low" || info.Session.Effort != "low" {
		t.Fatalf("设置未生效：%+v", info)
	}
	// 重建管理器，验证数据库与原 Pi 会话共同恢复，且不依赖常驻进程。
	deps := f.m.d
	f.m.Shutdown()
	f.m = New(deps)
	t.Cleanup(f.m.Shutdown)
	if err := f.m.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	if info = get(); info.Level != "low" || info.Override != "low" {
		t.Fatalf("重启丢失设置：%+v", info)
	}
	if info = set("default"); info.Level != "medium" || info.Override != "default" {
		t.Fatalf("应恢复配置中的 medium，不能沿用旧会话 low：%+v", info)
	}
	// default 模式在下次启动重新读取配置，而非固定为上一次的默认值。
	if err := os.WriteFile(filepath.Join(profile, "settings.json"), []byte(strings.Replace(settings, "medium", "low", 1)), 0600); err != nil {
		t.Fatal(err)
	}
	model := "OpenAI/gpt-6-astra"
	if _, err := f.m.Update(ctx, s.ID, Patch{Model: &model}); err != nil {
		t.Fatal(err)
	}
	if info = get(); info.Level != "low" {
		t.Fatalf("default 未重新读取 Pi 配置：%+v", info)
	}
	set("low")
	// 无思考能力的模型只能使用 off；无效参数不能保存，也不能变成聊天错误事件。
	model = "OpenAI/plain-model"
	if _, err := f.m.Update(ctx, s.ID, Patch{Model: &model}); err != nil {
		t.Fatal(err)
	}
	if info = get(); info.Level != "off" || info.Override != "low" || !slices.Equal(info.Levels, []string{"off"}) {
		t.Fatalf("未按模型能力过滤档位：%+v", info)
	}
	bad := "high"
	if _, err := f.m.Effort(ctx, s.ID, &bad); err == nil || !strings.Contains(err.Error(), "不支持") {
		t.Fatalf("应拒绝模型不支持的档位：%v", err)
	}
	stored, _ := f.st.Session(ctx, s.ID)
	if stored.Effort != "low" {
		t.Fatalf("无效操作污染保存的强度：%+v", stored)
	}
	if info = set("default"); info.Level != "off" || info.Override != "default" {
		t.Fatalf("默认档位也应按模型能力调整：%+v", info)
	}
	rt, _ := f.m.runtime(ctx, s.ID)
	for _, busy := range []string{StateRunning, StateAwaiting, StateInterrupted} {
		rt.mu.Lock()
		rt.state = busy
		rt.mu.Unlock()
		if _, err := f.m.Effort(ctx, s.ID, &bad); !errors.Is(err, ErrBusy) {
			t.Fatalf("%s 状态应禁止修改：%v", busy, err)
		}
	}
	rt.mu.Lock()
	rt.state = StateIdle
	rt.mu.Unlock()
	got, _ := os.ReadFile(filepath.Join(profile, "settings.json"))
	if string(got) != strings.Replace(settings, "medium", "low", 1) {
		t.Fatalf("修改会话强度不能改写全局设置：%s", got)
	}
	for _, e := range f.events(t, s.ID) {
		if e.Type == "msg.user" || e.Type == "error" {
			t.Fatalf("操作命令被当成聊天事件：%s %s", e.Type, e.Data)
		}
	}
}
