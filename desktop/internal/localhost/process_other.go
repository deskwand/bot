//go:build !unix

package localhost

import (
	"os/exec"
	"time"
)

// configureCommand bounds the wall-clock time of cmd with WaitDelay: on this
// platform there is no process group to kill.
func configureCommand(cmd *exec.Cmd) {
	cmd.WaitDelay = 5 * time.Second
}
