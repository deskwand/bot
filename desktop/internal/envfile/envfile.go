// Package envfile reads and writes docker compose env_file content while
// preserving everything it does not change.
package envfile

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"
)

// Dialect selects how values are parsed and written. Compose follows the
// docker compose env_file quoting rules; Plain writes the value verbatim, as
// Apple container reads it.
type Dialect int

const (
	Compose Dialect = iota
	Plain
)

var ErrUnrepresentable = errors.New("envfile: value cannot be written safely")
var ErrInvalidKey = errors.New("envfile: invalid key")

var (
	keyPattern  = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)
	bareValue   = regexp.MustCompile(`^[A-Za-z0-9_./:@+=,-]*$`)
	linePattern = regexp.MustCompile(`^(export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$`)
)

type line struct {
	raw        []byte
	prefix     string
	key        string
	value      string
	terminator string
	isKeyValue bool
	touched    bool
}

// File is a parsed env file. Untouched lines are kept as raw bytes.
type File struct {
	lines   []line
	dialect Dialect
}

// Parse reads a compose env file. Lines it does not understand are kept
// verbatim.
func Parse(data []byte) (*File, error) {
	return ParseDialect(data, Compose)
}

// ParseDialect reads an env file in the given dialect. Lines it does not
// understand are kept verbatim.
func ParseDialect(data []byte, d Dialect) (*File, error) {
	f := &File{dialect: d}
	for len(data) > 0 {
		i := bytes.IndexByte(data, '\n')
		var raw []byte
		if i < 0 {
			raw = data
			data = nil
		} else {
			raw = data[:i+1]
			data = data[i+1:]
		}
		f.lines = append(f.lines, parseLine(raw, d))
	}
	return f, nil
}

func parseLine(raw []byte, d Dialect) line {
	l := line{raw: raw}
	body := raw
	if n := len(body); n > 0 && body[n-1] == '\n' {
		if n >= 2 && body[n-2] == '\r' {
			l.terminator = "\r\n"
			body = body[:n-2]
		} else {
			l.terminator = "\n"
			body = body[:n-1]
		}
	}

	if d == Plain {
		return parsePlainLine(l, body)
	}

	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" || strings.HasPrefix(trimmed, "#") {
		return l
	}

	match := linePattern.FindStringSubmatch(string(body))
	if match == nil {
		return l
	}
	l.prefix = match[1]
	l.key = match[2]
	l.value = parseValue(match[3])
	l.isKeyValue = true
	return l
}

// parsePlainLine reads KEY=value as-is: no quote removal, no inline comments,
// no trimming. Empty lines, comments and anything whose left side is not a
// valid key stay verbatim.
func parsePlainLine(l line, body []byte) line {
	if len(body) == 0 || body[0] == '#' {
		return l
	}
	i := bytes.IndexByte(body, '=')
	if i < 0 {
		return l
	}
	key := string(body[:i])
	if !keyPattern.MatchString(key) {
		return l
	}
	l.key = key
	l.value = string(body[i+1:])
	l.isKeyValue = true
	return l
}

func parseValue(s string) string {
	if strings.HasPrefix(s, "'") {
		if i := strings.IndexByte(s[1:], '\''); i >= 0 {
			return s[1 : i+1]
		}
		return s[1:]
	}
	if strings.HasPrefix(s, `"`) {
		return parseDoubleQuoted(s[1:])
	}
	if i := inlineCommentIndex(s); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

func parseDoubleQuoted(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '"':
			return b.String()
		case '\\':
			if i+1 >= len(s) {
				b.WriteByte('\\')
				continue
			}
			switch s[i+1] {
			case '"':
				b.WriteByte('"')
				i++
			case '\\':
				b.WriteByte('\\')
				i++
			case 'n':
				b.WriteByte('\n')
				i++
			default:
				b.WriteByte('\\')
			}
		default:
			b.WriteByte(s[i])
		}
	}
	return b.String()
}

func inlineCommentIndex(s string) int {
	for i := 1; i < len(s); i++ {
		if s[i] == '#' && (s[i-1] == ' ' || s[i-1] == '\t') {
			return i - 1
		}
	}
	return -1
}

// Get returns the value of key. When a key appears more than once the last
// occurrence wins.
func (f *File) Get(key string) (string, bool) {
	for i := len(f.lines) - 1; i >= 0; i-- {
		l := f.lines[i]
		if l.isKeyValue && l.key == key {
			return l.value, true
		}
	}
	return "", false
}

// Keys returns the keys in first-appearance order, without duplicates.
func (f *File) Keys() []string {
	var keys []string
	seen := make(map[string]bool)
	for _, l := range f.lines {
		if !l.isKeyValue || seen[l.key] {
			continue
		}
		seen[l.key] = true
		keys = append(keys, l.key)
	}
	return keys
}

// Set changes the last occurrence of key in place, or appends it when the key
// is not present.
func (f *File) Set(key, value string) error {
	if !keyPattern.MatchString(key) {
		return ErrInvalidKey
	}
	if f.dialect == Plain {
		if strings.ContainsAny(value, "\n\r\x00") {
			return ErrUnrepresentable
		}
	} else if strings.ContainsAny(value, "'\n\r\x00") {
		return ErrUnrepresentable
	}

	for i := len(f.lines) - 1; i >= 0; i-- {
		l := &f.lines[i]
		if l.isKeyValue && l.key == key {
			l.value = value
			l.touched = true
			return nil
		}
	}

	newline := f.newlineStyle()
	if len(f.lines) > 0 {
		last := &f.lines[len(f.lines)-1]
		if last.touched {
			if last.terminator == "" {
				last.terminator = string(newline)
			}
		} else if len(last.raw) == 0 || last.raw[len(last.raw)-1] != '\n' {
			// Copy first: raw is a slice of the caller's buffer.
			last.raw = append(append([]byte(nil), last.raw...), newline...)
		}
	}

	raw := []byte(key + "=" + encodeValue(key, value, f.dialect))
	raw = append(raw, newline...)
	f.lines = append(f.lines, line{
		raw:        raw,
		key:        key,
		value:      value,
		terminator: string(newline),
		isKeyValue: true,
	})
	return nil
}

// Delete removes every occurrence of key.
func (f *File) Delete(key string) {
	kept := f.lines[:0]
	for _, l := range f.lines {
		if l.isKeyValue && l.key == key {
			continue
		}
		kept = append(kept, l)
	}
	f.lines = kept
}

// Bytes serializes the file. Untouched lines are emitted byte for byte.
func (f *File) Bytes() []byte {
	var out []byte
	for _, l := range f.lines {
		if !l.touched {
			out = append(out, l.raw...)
			continue
		}
		out = append(out, l.prefix...)
		out = append(out, l.key...)
		out = append(out, '=')
		out = append(out, encodeValue(l.key, l.value, f.dialect)...)
		out = append(out, l.terminator...)
	}
	return out
}

func (f *File) newlineStyle() []byte {
	for _, l := range f.lines {
		if i := bytes.IndexByte(l.raw, '\n'); i >= 0 {
			if i > 0 && l.raw[i-1] == '\r' {
				return []byte("\r\n")
			}
			return []byte("\n")
		}
	}
	return []byte("\n")
}

func encodeValue(key, value string, d Dialect) string {
	if d == Plain {
		return value
	}
	if key == "DESKWAND_CONFIG" || !bareValue.MatchString(value) {
		return "'" + value + "'"
	}
	return value
}

// Fingerprint returns the lowercase hexadecimal SHA-256 of data.
func Fingerprint(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
