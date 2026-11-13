package envfile

import (
	"bytes"
	"errors"
	"os"
	"reflect"
	"testing"
)

func TestRoundTripIsByteIdentical(t *testing.T) {
	data, err := os.ReadFile("../../../.env.container.example")
	if err != nil {
		t.Fatal(err)
	}
	f, err := Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	if got := f.Bytes(); !bytes.Equal(got, data) {
		t.Errorf("Bytes() does not round-trip:\ngot  %q\nwant %q", got, data)
	}
}

func TestGetReadsQuotingStyles(t *testing.T) {
	f, err := Parse([]byte("A=plain\nB='single $x # y'\nC=\"dq \\\"q\\\" \\\\ \\n\"\nD=bare # note\nexport E=1\n"))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"A": "plain",
		"B": "single $x # y",
		"C": "dq \"q\" \\ \n",
		"D": "bare",
		"E": "1",
	}
	for key, value := range want {
		got, ok := f.Get(key)
		if !ok || got != value {
			t.Errorf("Get(%q) = %q, %v; want %q, true", key, got, ok, value)
		}
	}
}

func TestDuplicateKeyLastWins(t *testing.T) {
	f, err := Parse([]byte("K=1\nK=2\n"))
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := f.Get("K"); !ok || got != "2" {
		t.Fatalf("Get(K) = %q, %v; want 2, true", got, ok)
	}
	if got := f.Keys(); !reflect.DeepEqual(got, []string{"K"}) {
		t.Fatalf("Keys() = %v; want [K]", got)
	}
	if err := f.Set("K", "3"); err != nil {
		t.Fatal(err)
	}
	if got := string(f.Bytes()); got != "K=1\nK=3\n" {
		t.Errorf("Bytes() = %q; want %q", got, "K=1\nK=3\n")
	}
	f.Delete("K")
	if got := f.Bytes(); len(got) != 0 {
		t.Errorf("Bytes() after Delete = %q; want empty", got)
	}
}

func TestSetPreservesUntouchedLinesAndCRLF(t *testing.T) {
	f, err := Parse([]byte("# c\r\nA=1\r\nB=2\r\n"))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Set("A", "9"); err != nil {
		t.Fatal(err)
	}
	if err := f.Set("N", "x y"); err != nil {
		t.Fatal(err)
	}
	want := "# c\r\nA=9\r\nB=2\r\nN='x y'\r\n"
	if got := string(f.Bytes()); got != want {
		t.Errorf("Bytes() = %q; want %q", got, want)
	}
}

func TestSetQuotesConfigAlways(t *testing.T) {
	f, err := Parse(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Set("DESKWAND_CONFIG", `{"a":1}`); err != nil {
		t.Fatal(err)
	}
	want := `DESKWAND_CONFIG='{"a":1}'` + "\n"
	if got := string(f.Bytes()); got != want {
		t.Fatalf("Bytes() = %q; want %q", got, want)
	}
	g, err := Parse(f.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := g.Get("DESKWAND_CONFIG"); !ok || got != `{"a":1}` {
		t.Errorf("Get(DESKWAND_CONFIG) = %q, %v; want %q, true", got, ok, `{"a":1}`)
	}
}

func TestSetRejectsUnrepresentable(t *testing.T) {
	for _, value := range []string{"it's", "a\nb", "a\rb", "a\x00b"} {
		f, err := Parse([]byte("A=1\n"))
		if err != nil {
			t.Fatal(err)
		}
		before := string(f.Bytes())
		err = f.Set("A", value)
		if !errors.Is(err, ErrUnrepresentable) {
			t.Errorf("Set(A, %q) error = %v; want ErrUnrepresentable", value, err)
		}
		if got := string(f.Bytes()); got != before {
			t.Errorf("Bytes() changed after rejected Set: %q", got)
		}
	}
}

func TestSetRejectsInvalidKey(t *testing.T) {
	for _, key := range []string{"lower", "1A", "A-B", ""} {
		f, err := Parse(nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := f.Set(key, "x"); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("Set(%q) error = %v; want ErrInvalidKey", key, err)
		}
	}
}

func TestUnknownLinesSurvive(t *testing.T) {
	input := []byte("garbage line\nA=1\n")
	f, err := Parse(input)
	if err != nil {
		t.Fatal(err)
	}
	if got := f.Keys(); !reflect.DeepEqual(got, []string{"A"}) {
		t.Errorf("Keys() = %v; want [A]", got)
	}
	if got := f.Bytes(); !bytes.Equal(got, input) {
		t.Errorf("Bytes() = %q; want %q", got, input)
	}
}

func TestFingerprint(t *testing.T) {
	const want = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	if got := Fingerprint([]byte("abc")); got != want {
		t.Errorf("Fingerprint(abc) = %q; want %q", got, want)
	}
}

func TestSetDoesNotWriteIntoCallerBuffer(t *testing.T) {
	buffer := []byte("A=1XXXX")
	file, err := Parse(buffer[:3])
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Set("B", "2"); err != nil {
		t.Fatal(err)
	}
	if string(buffer) != "A=1XXXX" {
		t.Fatalf("caller buffer changed to %q", buffer)
	}
	if got := string(file.Bytes()); got != "A=1\nB=2\n" {
		t.Fatalf("bytes = %q", got)
	}
}
