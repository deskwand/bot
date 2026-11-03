package release

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The ordering table is shared with tests-node/worker-release.test.ts. Both the
// builder and the client must read it the same way: a version the builder
// orders as "older than the release" has to be older for the upgrade gate too.
func TestVersionOrderParityFixture(t *testing.T) {
	path := filepath.Join("..", "..", "..", "contracts", "fixtures", "release", "version-order.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fixture struct {
		Cases []struct {
			Left   string `json:"left"`
			Right  string `json:"right"`
			Expect *int   `json:"expect"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("fixture has no cases")
	}

	for _, testCase := range fixture.Cases {
		comparison, comparable := CompareVersions(testCase.Left, testCase.Right)
		if testCase.Expect == nil {
			if comparable {
				t.Fatalf("CompareVersions(%q, %q) = %d, want not comparable", testCase.Left, testCase.Right, comparison)
			}
			continue
		}
		if !comparable {
			t.Fatalf("CompareVersions(%q, %q) not comparable, want %d", testCase.Left, testCase.Right, *testCase.Expect)
		}
		if comparison != *testCase.Expect {
			t.Fatalf("CompareVersions(%q, %q) = %d, want %d", testCase.Left, testCase.Right, comparison, *testCase.Expect)
		}
		reverse, ok := CompareVersions(testCase.Right, testCase.Left)
		if !ok || reverse != -comparison {
			t.Fatalf("CompareVersions(%q, %q) = %d, %v; want %d", testCase.Right, testCase.Left, reverse, ok, -comparison)
		}
	}
}
