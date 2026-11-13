//go:build unix

package localhost

import (
	"os/exec"
	"syscall"
	"time"
)

// configureCommand bounds the wall-clock time of cmd. Cancelling kills the
// shell's whole process group, because the shell's children inherit the output
// pipes and would otherwise keep Wait blocked; WaitDelay is the backstop when
// one of them survives anyway.
func configureCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	cmd.WaitDelay = 5 * time.Second
}
