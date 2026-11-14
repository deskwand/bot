package backup

import (
	"errors"
	"testing"

	"github.com/deskwand/bot/desktop/internal/domain"
)

func manifestAt(release string) Manifest {
	return Manifest{Format: FormatVersion, Release: release}
}

func snapshotAt(release string) domain.Snapshot {
	return domain.Snapshot{ReleaseVersion: release}
}

func TestCheckVersionAllowsOlderAndEqual(t *testing.T) {
	for _, tc := range []struct{ backup, target string }{
		{"0.1.40", "0.1.51"},
		{"0.1.51", "0.1.51"},
	} {
		if err := CheckVersion(manifestAt(tc.backup), snapshotAt(tc.target)); err != nil {
			t.Fatalf("backup %s onto %s: %v", tc.backup, tc.target, err)
		}
		if warnings := VersionWarnings(manifestAt(tc.backup), snapshotAt(tc.target)); len(warnings) != 0 {
			t.Fatalf("backup %s onto %s: warnings %v", tc.backup, tc.target, warnings)
		}
	}
}

func TestCheckVersionRejectsNewerBackup(t *testing.T) {
	err := CheckVersion(manifestAt("0.1.60"), snapshotAt("0.1.51"))
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != CodeBackupVersionMismatch {
		t.Fatalf("CheckVersion() = %v, want %s", err, CodeBackupVersionMismatch)
	}
}

// VersionWarnings returns stable codes, not prose: the page maps them through
// its own i18n catalog like every other backend code.
func TestCheckVersionUnknownReleaseWarns(t *testing.T) {
	cases := []struct {
		backup, target, code string
	}{
		{"unknown", "0.1.51", CodeReleaseUnknownBackup},
		{"0.1.51", "unknown", CodeReleaseUnknownTarget},
		{"", "0.1.51", CodeReleaseUnknownBackup},
	}
	for _, tc := range cases {
		if err := CheckVersion(manifestAt(tc.backup), snapshotAt(tc.target)); err != nil {
			t.Fatalf("backup %q onto %q: %v", tc.backup, tc.target, err)
		}
		warnings := VersionWarnings(manifestAt(tc.backup), snapshotAt(tc.target))
		if len(warnings) != 1 || warnings[0] != tc.code {
			t.Fatalf("backup %q onto %q: warnings %v, want [%s]", tc.backup, tc.target, warnings, tc.code)
		}
	}
}

func TestVersionWarningsFlagsUnparseableNumbers(t *testing.T) {
	// A release string that is neither known nor semver must warn, not crash.
	warnings := VersionWarnings(manifestAt("build-7"), snapshotAt("0.1.51"))
	if len(warnings) != 1 || warnings[0] != CodeReleaseUncomparable {
		t.Fatalf("warnings = %v, want [%s]", warnings, CodeReleaseUncomparable)
	}
}

func TestCheckTargetLimitsRejectsOversizedObjectsForContainers(t *testing.T) {
	m := Manifest{Format: FormatVersion, R2: R2Manifest{Objects: []R2Item{
		{Key: "artifacts/big.bin", Size: ContainerMaxObjectBytes + 1},
	}}}
	box := domain.Target{Kind: domain.TargetContainer}
	err := CheckTargetLimits(m, box)
	var coded domain.Error
	if !errors.As(err, &coded) || coded.Code != CodeBackupObjectTooLargeForTarget {
		t.Fatalf("CheckTargetLimits() = %v, want %s", err, CodeBackupObjectTooLargeForTarget)
	}
	if err := CheckTargetLimits(m, domain.Target{ScriptName: "deskwand-bot"}); err != nil {
		t.Fatalf("a Worker must accept the same backup: %v", err)
	}
	small := Manifest{Format: FormatVersion, R2: R2Manifest{Objects: []R2Item{
		{Key: "artifacts/small.bin", Size: ContainerMaxObjectBytes},
	}}}
	if err := CheckTargetLimits(small, box); err != nil {
		t.Fatalf("an object exactly at the cap must pass: %v", err)
	}
}
