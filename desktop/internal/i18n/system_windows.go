//go:build windows

package i18n

import (
	"fmt"
	"syscall"
	"unsafe"
)

const localeNameMaxLength = 85

var (
	kernel32                 = syscall.NewLazyDLL("kernel32.dll")
	getUserDefaultUILanguage = kernel32.NewProc("GetUserDefaultUILanguage")
	lcidToLocaleName         = kernel32.NewProc("LCIDToLocaleName")
)

// SystemLanguage returns the user's UI language on Windows, for example
// "zh-Hans".
func SystemLanguage() (string, error) {
	lcid, _, _ := getUserDefaultUILanguage.Call()
	if lcid == 0 {
		return "", fmt.Errorf("i18n: GetUserDefaultUILanguage failed")
	}
	var name [localeNameMaxLength]uint16
	n, _, err := lcidToLocaleName.Call(
		lcid,
		uintptr(unsafe.Pointer(&name[0])),
		uintptr(len(name)),
		0,
	)
	if n == 0 {
		return "", fmt.Errorf("i18n: LCIDToLocaleName: %w", err)
	}
	return syscall.UTF16ToString(name[:]), nil
}
