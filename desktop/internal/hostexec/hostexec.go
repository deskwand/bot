// Package hostexec holds the command result type shared by the host clients.
// It has no dependencies on other internal packages.
package hostexec

import (
	"errors"
	"strings"
)

// Result is the outcome of a command run on a host. A nonzero ExitCode is not
// an error; errors mean the transport failed.
type Result struct {
	Stdout   []byte
	Stderr   []byte
	ExitCode int
}

// ErrNotExist reports that a path does not exist.
var ErrNotExist = errors.New("hostexec: file does not exist")

// QuotePath turns a validated path into a shell word. A leading "~/" becomes
// the quoted $HOME, so the path is never expanded as a bare word.
func QuotePath(path string) string {
	if path == "~" {
		return "'~'"
	}
	if rest, ok := strings.CutPrefix(path, "~/"); ok {
		return `"$HOME"/'` + rest + `'`
	}
	return "'" + path + "'"
}
