package agent

import (
	"fmt"
	"os"
	"sync/atomic"
	"testing"
	"time"
)

func TestLineProcFloodHelper(t *testing.T) {
	if os.Getenv("POCKETDESK_TEST_FLOOD_PROCESS") != "1" {
		t.Skip("subprocess helper")
	}
	for {
		fmt.Fprintln(os.Stdout, "{}")
	}
}

// Navigation closes a failed Pi while holding its session lock, so its event
// consumer may be paused. Close must still allow Done to complete.
func TestLineProcCloseWithFullEventQueue(t *testing.T) {
	full := make(chan struct{})
	var lines atomic.Int32
	p, err := startLineProc([]string{os.Args[0], "-test.run=^TestLineProcFloodHelper$"}, t.TempDir(), []string{"POCKETDESK_TEST_FLOOD_PROCESS=1"}, func(p *lineProc, _ []byte) {
		if lines.Add(1) == int32(cap(p.events)+1) {
			close(full)
		}
		p.emit(Event{})
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		p.Close()
		go func() {
			for range p.Events() {
			}
		}()
	})
	select {
	case <-full:
	case <-time.After(5 * time.Second):
		t.Fatal("process did not fill the event queue")
	}
	p.Close()
	select {
	case <-p.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("Close cannot complete while the session's event consumer is paused")
	}
}
