package app

import (
	"context"
	"os"
	"path/filepath"
	"time"

	"github.com/deskwand/bot/desktop/internal/auth"
	"github.com/deskwand/bot/desktop/internal/backup"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/telemetry"
)

// Error codes returned by the move flows. They are stable contract values; the
// message is for humans.
const (
	CodeMoveNoPrevious     = "MOVE_NO_PREVIOUS"
	CodeMoveAlreadyRunning = "MOVE_ALREADY_RUNNING"
	CodeMoveSourceMuted    = "MOVE_SOURCE_MUTE_FAILED"
	CodeMoveArchiveMissing = "MOVE_ARCHIVE_MISSING"
)

// ResidenceDTO names one residence for the page.
type ResidenceDTO struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Reachable bool   `json:"reachable"`
}

// MoveDTO is the state the move page renders.
type MoveDTO struct {
	Phase       string               `json:"phase"`
	ArchivePath string               `json:"archivePath,omitempty"`
	From        ResidenceDTO         `json:"from"`
	Summary     backup.ManifestBrief `json:"summary"`
}

// MoveExporter packs the old residence and opens the archive in the new one.
type MoveExporter interface {
	Export(ctx context.Context, target domain.Target, path string) (backup.Manifest, error)
	Restore(ctx context.Context, target domain.Target, path string) error
}

// MoveMuter silences a residence: a container is stopped, a Worker drops its
// entry selection. Both keep credentials and data untouched.
type MoveMuter interface {
	Mute(ctx context.Context, target domain.Target) error
	Revive(ctx context.Context, target domain.Target, channel string) error
}

// StartMove packs the current residence, silences it, and records the move.
// Silencing happens before the new residence exists, so the two never poll the
// same entry at once.
func (s *Service) StartMove() (*MoveDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return nil, err
	}
	if s.moveExporter == nil || s.moveMuter == nil || s.moveJournal == nil || s.settings == nil {
		return nil, s.serviceUnavailable()
	}
	record, err := s.moveJournal.Read()
	if err != nil {
		return nil, safeAppError(err)
	}
	if record != nil && record.Phase != backup.MoveDone && record.Phase != backup.MoveAbandoned {
		return nil, domain.Error{Code: CodeMoveAlreadyRunning}
	}
	settings, err := s.settings.Settings()
	if err != nil {
		return nil, safeAppError(err)
	}
	if err := ensureWritableDirIn(s.locale.Current(), settings.Dir); err != nil {
		return nil, err
	}
	path := filepath.Join(settings.Dir, backupFileName(target, s.now()))
	manifest, err := s.moveExporter.Export(ctx, target, path)
	if err != nil {
		return nil, safeAppError(err)
	}

	next := backup.MoveRecord{
		Phase:       backup.MoveMuting,
		ArchivePath: path,
		From:        target,
		FromChannel: s.activeChannel(ctx, target),
		Summary: backup.ManifestBrief{
			Release:    manifest.Release,
			ExportedAt: manifest.ExportedAt.UTC().Format(time.RFC3339),
			Bytes:      fileSize(path),
		},
	}
	if err := s.moveJournal.Write(next); err != nil {
		return nil, safeAppError(err)
	}
	if err := s.moveMuter.Mute(ctx, target); err != nil {
		return nil, domain.Error{Code: CodeMoveSourceMuted, Message: appErrorCode(err)}
	}
	next.Phase = backup.MoveHoming
	if err := s.moveJournal.Write(next); err != nil {
		return nil, safeAppError(err)
	}
	s.reportAction(telemetry.FeatureBackup, nil)
	return s.moveDTO(next), nil
}

// SettleMove installs the archive into the current residence, which the deploy
// flow already wrote to settings.json.
func (s *Service) SettleMove() error {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return err
	}
	if s.moveExporter == nil || s.moveJournal == nil || s.store == nil {
		return s.serviceUnavailable()
	}
	record, err := s.moveJournal.Read()
	if err != nil {
		return safeAppError(err)
	}
	if record == nil || record.Phase != backup.MoveHoming {
		return domain.Error{Code: CodeMoveNoPrevious, Message: "no move is waiting to be settled"}
	}
	if _, err := os.Stat(record.ArchivePath); err != nil {
		return domain.Error{Code: CodeMoveArchiveMissing, Message: record.ArchivePath}
	}
	if err := s.store.SetPrevious(record.From); err != nil {
		return safeAppError(err)
	}
	restoreErr := safeAppError(s.moveExporter.Restore(ctx, target, record.ArchivePath))
	s.reportAction(telemetry.FeatureRestore, restoreErr)
	if restoreErr != nil {
		return restoreErr
	}
	record.Phase = backup.MoveDone
	return safeAppError(s.moveJournal.Write(*record))
}

// MoveBack swaps the residences and revives the old entry, so the old
// residence answers again without another backup.
func (s *Service) MoveBack() error {
	ctx := context.Background()
	if s.store == nil || s.moveJournal == nil {
		return s.serviceUnavailable()
	}
	record, err := s.moveJournal.Read()
	if err != nil {
		return safeAppError(err)
	}
	if err := s.store.SwapResidence(); err != nil {
		return safeAppError(err)
	}
	if record != nil && record.FromChannel != "" && s.moveMuter != nil {
		previous, ok, err := s.store.Previous()
		if err == nil && ok {
			_ = s.moveMuter.Revive(ctx, previous, record.FromChannel)
		}
	}
	if record != nil {
		record.Phase = backup.MoveDone
		_ = s.moveJournal.Write(*record)
	}
	return nil
}

// AbandonMove forgets the move without reviving the old residence; the page
// offers ReviveOldHouse separately.
func (s *Service) AbandonMove() error {
	if s.moveJournal == nil {
		return s.serviceUnavailable()
	}
	record, err := s.moveJournal.Read()
	if err != nil {
		return safeAppError(err)
	}
	if record == nil {
		return nil
	}
	record.Phase = backup.MoveAbandoned
	return safeAppError(s.moveJournal.Write(*record))
}

// ReviveOldHouse restores the entry of an abandoned move.
func (s *Service) ReviveOldHouse() error {
	if s.moveJournal == nil || s.moveMuter == nil {
		return s.serviceUnavailable()
	}
	record, err := s.moveJournal.Read()
	if err != nil {
		return safeAppError(err)
	}
	if record == nil || record.FromChannel == "" {
		return nil
	}
	if err := s.moveMuter.Revive(context.Background(), record.From, record.FromChannel); err != nil {
		return safeAppError(err)
	}
	// The record only existed to remember how to wake the old residence, so it
	// goes away once the old residence answers again.
	return safeAppError(s.moveJournal.Clear())
}

// MoveStatus reports the recorded move, or nil when none exists.
func (s *Service) MoveStatus() (*MoveDTO, error) {
	if s.moveJournal == nil {
		return nil, nil
	}
	record, err := s.moveJournal.Read()
	if err != nil {
		return nil, safeAppError(err)
	}
	if record == nil {
		return nil, nil
	}
	return s.moveDTO(*record), nil
}

func (s *Service) moveDTO(record backup.MoveRecord) *MoveDTO {
	return &MoveDTO{
		Phase:       record.Phase,
		ArchivePath: record.ArchivePath,
		From:        s.residenceDTO(record.From),
		Summary:     record.Summary,
	}
}

func (s *Service) residenceDTO(target domain.Target) ResidenceDTO {
	return ResidenceDTO{
		Kind:      residenceKind(target),
		Name:      s.targetName(target),
		Reachable: s.residenceReachable(context.Background(), target),
	}
}

func residenceKind(target domain.Target) string {
	if target.IsContainer() {
		return domain.TargetContainer
	}
	return domain.TargetCloudflare
}

// residenceReachable reports whether the page can talk to a residence right
// now: a container needs no login, a Worker needs a live Cloudflare session.
func (s *Service) residenceReachable(ctx context.Context, target domain.Target) bool {
	if target.IsContainer() {
		return true
	}
	if s.auth == nil {
		return false
	}
	connection, err := s.auth.Status(ctx)
	return err == nil && connection.State == auth.StateConnected
}

// activeChannel reads the entry a residence is using now, so an abandoned move
// can put it back. A missing value means the Worker default (telegram).
func (s *Service) activeChannel(ctx context.Context, target domain.Target) string {
	if s.snapshots == nil {
		return EntryTelegram
	}
	snapshot, err := s.snapshots.ReadSnapshot(ctx, target)
	if err != nil {
		return EntryTelegram
	}
	switch value := ReadPlainVar(snapshot.SettingsJSON, "ACTIVE_CHANNEL"); value {
	case EntryTelegram, EntryWeChat:
		return value
	default:
		return EntryTelegram
	}
}

func fileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
}
