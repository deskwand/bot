package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
)

// CanonicalJSON returns the canonical encoding of v: object keys sorted, no
// insignificant whitespace, and JSON numbers preserved exactly as parsed.
func CanonicalJSON(v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return CanonicalizeJSON(raw)
}

// CanonicalizeJSON decodes one JSON value and re-encodes it canonically.
// Numbers are kept as json.Number so large integers do not lose precision.
func CanonicalizeJSON(raw []byte) ([]byte, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, errors.New("trailing JSON value")
		}
		return nil, err
	}

	var buffer bytes.Buffer
	if err := writeCanonical(&buffer, value); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

// DecodeJSON decodes exactly one JSON value with numbers as json.Number.
func DecodeJSON(raw []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, errors.New("trailing JSON value")
		}
		return nil, err
	}
	return value, nil
}

func writeCanonical(buffer *bytes.Buffer, value any) error {
	switch typed := value.(type) {
	case nil:
		buffer.WriteString("null")
	case bool:
		if typed {
			buffer.WriteString("true")
		} else {
			buffer.WriteString("false")
		}
	case string:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return err
		}
		buffer.Write(encoded)
	case json.Number:
		if _, err := strconv.ParseFloat(typed.String(), 64); err != nil {
			return fmt.Errorf("invalid JSON number %q", typed.String())
		}
		buffer.WriteString(typed.String())
	case float64:
		buffer.WriteString(strconv.FormatFloat(typed, 'g', -1, 64))
	case []any:
		buffer.WriteByte('[')
		for i, item := range typed {
			if i > 0 {
				buffer.WriteByte(',')
			}
			if err := writeCanonical(buffer, item); err != nil {
				return err
			}
		}
		buffer.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		buffer.WriteByte('{')
		for i, key := range keys {
			if i > 0 {
				buffer.WriteByte(',')
			}
			encodedKey, err := json.Marshal(key)
			if err != nil {
				return err
			}
			buffer.Write(encodedKey)
			buffer.WriteByte(':')
			if err := writeCanonical(buffer, typed[key]); err != nil {
				return err
			}
		}
		buffer.WriteByte('}')
	default:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return err
		}
		return writeCanonical(buffer, mustDecode(encoded))
	}
	return nil
}

func mustDecode(raw []byte) any {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil
	}
	return value
}
