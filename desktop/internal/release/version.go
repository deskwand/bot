package release

import (
	"strconv"
	"strings"
)

// CompareVersions compares two semver-like release versions and returns -1, 0
// or 1. It returns comparable=false when either value is not a version this
// client understands.
//
// Prerelease precedence follows semver: a release is newer than its own
// prerelease (1.0.0 > 1.0.0-beta), and build metadata is ignored.
//
// The release package owns the comparison so the manifest verifier and the
// deployment client cannot disagree about ordering.
func CompareVersions(left, right string) (int, bool) {
	leftVersion, ok := parseVersion(left)
	if !ok {
		return 0, false
	}
	rightVersion, ok := parseVersion(right)
	if !ok {
		return 0, false
	}
	size := len(leftVersion.core)
	if len(rightVersion.core) > size {
		size = len(rightVersion.core)
	}
	for i := 0; i < size; i++ {
		var a, b int
		if i < len(leftVersion.core) {
			a = leftVersion.core[i]
		}
		if i < len(rightVersion.core) {
			b = rightVersion.core[i]
		}
		if a < b {
			return -1, true
		}
		if a > b {
			return 1, true
		}
	}
	switch {
	case !leftVersion.hasPre && !rightVersion.hasPre:
		return 0, true
	case !leftVersion.hasPre:
		return 1, true
	case !rightVersion.hasPre:
		return -1, true
	}
	size = len(leftVersion.pre)
	if len(rightVersion.pre) > size {
		size = len(rightVersion.pre)
	}
	for i := 0; i < size; i++ {
		if i >= len(leftVersion.pre) {
			return -1, true
		}
		if i >= len(rightVersion.pre) {
			return 1, true
		}
		a, b := leftVersion.pre[i], rightVersion.pre[i]
		aNumber, aNumeric := numericIdentifier(a)
		bNumber, bNumeric := numericIdentifier(b)
		switch {
		case aNumeric && bNumeric:
			if aNumber < bNumber {
				return -1, true
			}
			if aNumber > bNumber {
				return 1, true
			}
		case aNumeric:
			return -1, true
		case bNumeric:
			return 1, true
		default:
			if a < b {
				return -1, true
			}
			if a > b {
				return 1, true
			}
		}
	}
	return 0, true
}

type parsedVersion struct {
	core   []int
	pre    []string
	hasPre bool
}

func parseVersion(value string) (parsedVersion, bool) {
	trimmed := strings.TrimSpace(strings.TrimPrefix(value, "v"))
	if trimmed == "" {
		return parsedVersion{}, false
	}
	if index := strings.IndexByte(trimmed, '+'); index >= 0 {
		trimmed = trimmed[:index]
	}
	var prerelease string
	if index := strings.IndexByte(trimmed, '-'); index >= 0 {
		prerelease = trimmed[index+1:]
		trimmed = trimmed[:index]
	}
	if trimmed == "" {
		return parsedVersion{}, false
	}
	parts := strings.Split(trimmed, ".")
	if len(parts) > 8 {
		return parsedVersion{}, false
	}
	result := parsedVersion{core: make([]int, len(parts))}
	for i, part := range parts {
		if !isNumericSegment(part) {
			return parsedVersion{}, false
		}
		number, err := strconv.Atoi(part)
		if err != nil {
			return parsedVersion{}, false
		}
		result.core[i] = number
	}
	if prerelease != "" {
		identifiers := strings.Split(prerelease, ".")
		result.hasPre = true
		result.pre = identifiers
		for _, identifier := range identifiers {
			if identifier == "" {
				return parsedVersion{}, false
			}
			for _, r := range identifier {
				if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-') {
					return parsedVersion{}, false
				}
			}
		}
	}
	return result, true
}

func numericIdentifier(value string) (int, bool) {
	if !isNumericSegment(value) {
		return 0, false
	}
	number, err := strconv.Atoi(value)
	if err != nil {
		return 0, false
	}
	return number, true
}

// isNumericSegment reports whether value is a plain run of at most 15 digits,
// so it fits in an int64 and carries no sign. The TypeScript builder
// (parseReleaseVersion) applies the same rule; both sides must classify a
// segment the same way or they would order versions differently.
func isNumericSegment(value string) bool {
	if value == "" || len(value) > 15 {
		return false
	}
	for i := 0; i < len(value); i++ {
		if value[i] < '0' || value[i] > '9' {
			return false
		}
	}
	return true
}
