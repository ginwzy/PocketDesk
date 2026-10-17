package agent

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// Run in a fresh process so sysenv.Login's cached environment is isolated.
func TestDetectWithInteractivePath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("requires a login shell")
	}
	if os.Getenv("PD_TEST_INTERACTIVE_PATH") == "1" {
		want := filepath.Join(os.Getenv("SHELL")+".bin", "pi")
		if got, err := LookPath("pi"); err != nil || got != want {
			t.Fatalf("LookPath(pi) = %q, %v; want %q", got, err, want)
		}
		for _, info := range Detect(map[string][]string{KindPi: {"pi"}}) {
			if info.Kind == KindPi && (!info.Installed || info.Version != "pi-test-version") {
				t.Fatalf("Pi must be found and run with node from the interactive PATH: %+v", info)
			}
		}
		return
	}
	dir := t.TempDir()
	shell := filepath.Join(dir, "shell")
	bin := shell + ".bin"
	if err := os.Mkdir(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		shell:                      "#!/bin/sh\n[ \"$1\" = -l ] && [ \"$2\" = -i ] && [ \"$3\" = -c ] || exit 1\nprintf 'startup output\\n\\000PD-ENV\\000'\nprintf 'PATH=%s\\000' \"$0.bin:/usr/bin:/bin\"\n",
		filepath.Join(bin, "pi"):   "#!/usr/bin/env node\n",
		filepath.Join(bin, "node"): "#!/bin/sh\nprintf 'pi-test-version\\n'\n",
	}
	for path, content := range files {
		if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestDetectWithInteractivePath$")
	cmd.Env = append(os.Environ(), "PD_TEST_INTERACTIVE_PATH=1", "SHELL="+shell, "PATH=/usr/bin:/bin")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("interactive PATH detection failed: %v\n%s", err, out)
	}
}
