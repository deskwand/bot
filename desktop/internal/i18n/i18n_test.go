package i18n

import (
	"errors"
	"regexp"
	"slices"
	"strconv"
	"testing"
)

func TestResolve(t *testing.T) {
	sys := func(tag string, err error) func() (string, error) {
		return func() (string, error) { return tag, err }
	}
	cases := []struct {
		source, tag string
		err         error
		want        string
	}{
		{"zh", "en-US", nil, "zh"},
		{"en", "zh-Hans", nil, "en"},
		{"system", "zh-Hans", nil, "zh"},
		{"system", "zh-TW", nil, "zh"},
		{"system", "en-US", nil, "en"},
		{"system", "ja", nil, "en"},
		{"system", "", errors.New("x"), "en"},
		{"bogus", "zh-CN", nil, "zh"},
	}
	for _, c := range cases {
		if got := Resolve(c.source, sys(c.tag, c.err)); got != c.want {
			t.Errorf("Resolve(%q, %q) = %q, want %q", c.source, c.tag, got, c.want)
		}
	}
}

func TestParseAppleLanguages(t *testing.T) {
	cases := []struct {
		name string
		out  string
		want string
	}{
		{"quoted only", "(\n    \"zh-Hans-CN\"\n)", "zh-Hans-CN"},
		{"unquoted first", "(\n    en,\n    \"zh-Hans-CN\"\n)", "en"},
		{"quoted first", "(\n    \"en-US\",\n    \"zh-Hans\"\n)", "en-US"},
		{"empty", "()", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := parseAppleLanguages([]byte(c.out))
			if c.want == "" {
				if err == nil {
					t.Fatalf("parseAppleLanguages(%q) = %q, nil; want an error", c.out, got)
				}
				return
			}
			if err != nil || got != c.want {
				t.Fatalf("parseAppleLanguages(%q) = %q, %v; want %q, nil", c.out, got, err, c.want)
			}
		})
	}
}

func TestTablesHaveSameKeys(t *testing.T) {
	for key := range zh {
		if _, ok := en[key]; !ok {
			t.Errorf("en is missing key %q", key)
		}
	}
	for key := range en {
		if _, ok := zh[key]; !ok {
			t.Errorf("zh is missing key %q", key)
		}
	}
}

func TestTablesHaveSameVerbs(t *testing.T) {
	for key, zhText := range zh {
		enText, ok := en[key]
		if !ok {
			continue
		}
		zhVerbs := normalizeVerbs(zhText)
		enVerbs := normalizeVerbs(enText)
		if !slices.Equal(zhVerbs, enVerbs) {
			t.Errorf("%q verbs: zh %v, en %v", key, zhVerbs, enVerbs)
		}
	}
}

func TestNormalizeVerbsOrdersByArgumentIndex(t *testing.T) {
	if got, want := normalizeVerbs("%[2]d in %[1]s"), []string{"%s", "%d"}; !slices.Equal(got, want) {
		t.Fatalf("indexed verbs = %v, want %v", got, want)
	}
	if got, want := normalizeVerbs("%s then %d"), []string{"%s", "%d"}; !slices.Equal(got, want) {
		t.Fatalf("plain verbs = %v, want %v", got, want)
	}
}

var verbPattern = regexp.MustCompile(`%(?:\[([0-9]+)\])?([-+# 0]*[0-9]*(?:\.[0-9]+)?[a-zA-Z%])`)

// normalizeVerbs returns each verb with its argument index removed, ordered by
// that index. Indexed verbs such as %[2]s therefore compare equal to the
// unindexed verbs of a translation that uses the same argument order.
func normalizeVerbs(text string) []string {
	type indexedVerb struct {
		index int
		verb  string
	}
	matches := verbPattern.FindAllStringSubmatch(text, -1)
	verbs := make([]indexedVerb, 0, len(matches))
	next := 1
	for _, match := range matches {
		index := next
		if match[1] != "" {
			index, _ = strconv.Atoi(match[1])
		}
		next = index + 1
		verbs = append(verbs, indexedVerb{index: index, verb: "%" + match[2]})
	}
	slices.SortStableFunc(verbs, func(a, b indexedVerb) int { return a.index - b.index })
	out := make([]string, len(verbs))
	for i, verb := range verbs {
		out[i] = verb.verb
	}
	return out
}

func TestJoinPanicsOnDuplicate(t *testing.T) {
	defer func() {
		got := recover()
		if got != "i18n: duplicate key a" {
			t.Fatalf("recover() = %v, want the duplicate key panic", got)
		}
	}()
	join(map[string]string{"a": "1"}, map[string]string{"a": "2"})
}

func TestLookup(t *testing.T) {
	if got, ok := Lookup("en", "locale.invalid"); !ok || got != "Invalid language setting" {
		t.Fatalf("Lookup(en) = %q, %v", got, ok)
	}

	zh["test.only"] = "只有中文 %d"
	t.Cleanup(func() { delete(zh, "test.only") })
	if got, ok := Lookup("en", "test.only", 3); !ok || got != "只有中文 3" {
		t.Fatalf("Lookup(en fallback) = %q, %v", got, ok)
	}
	if got, ok := Lookup("en", "missing.key"); ok || got != "" {
		t.Fatalf("Lookup(missing) = %q, %v; want empty and false", got, ok)
	}
}

func TestTFallsBack(t *testing.T) {
	zh["test.only"] = "只有中文 %d"
	t.Cleanup(func() { delete(zh, "test.only") })
	if got := T("en", "test.only", 3); got != "只有中文 3" {
		t.Fatalf("got %q", got)
	}
	if got := T("en", "missing.key"); got != "missing.key" {
		t.Fatalf("got %q", got)
	}
}
