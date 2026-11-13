package container

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/deskwand/bot/desktop/internal/config"
	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/envfile"
	"github.com/deskwand/bot/desktop/internal/hostexec"
	"github.com/deskwand/bot/desktop/internal/i18n"
)

// Preview describes a publish without writing anything remote.
func (s *Service) Preview(ctx context.Context, target domain.Target, change domain.Change) ([]domain.Step, error) {
	snapshot, err := s.ReadSnapshot(ctx, target)
	if err != nil {
		return nil, err
	}
	if _, err := config.Merge(snapshot, change); err != nil {
		return nil, err
	}
	return []domain.Step{
		s.step("restart", "info"),
		s.step("write-env", "planned"),
		s.step("healthy", "planned"),
	}, nil
}

func (s *Service) step(id, state string) domain.Step {
	return domain.Step{
		ID:      id,
		State:   state,
		Message: i18n.T(s.locale(), "container.step."+stepKeys[id]),
	}
}

// Apply merges the change into the remote .env, restarts the container, and
// waits until it is healthy. The .env.bak backup is written before the new
// file. Even when the bytes are unchanged the container is restarted, because
// a previous attempt may have written the file and then lost the connection.
func (s *Service) Apply(ctx context.Context, target domain.Target, change domain.Change) (domain.Result, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	host, err := s.dial(target)
	if err != nil {
		return domain.Result{}, err
	}
	dir := target.Host.Dir
	engine := s.engine(target)
	data, file, err := s.readEnvelope(ctx, host, dir, engine)
	if err != nil {
		return domain.Result{}, err
	}

	snapshotCtx, cancelSnapshot := context.WithTimeout(ctx, commandTimeout)
	snapshot, err := s.snapshotFromEnv(snapshotCtx, target, host, engine, data, file)
	cancelSnapshot()
	if err != nil {
		return domain.Result{}, err
	}
	plan, err := config.Merge(snapshot, change)
	if err != nil {
		return domain.Result{}, err
	}
	if err := applyPlan(file, plan); err != nil {
		return domain.Result{}, err
	}

	if updated := file.Bytes(); !bytes.Equal(updated, data) {
		if err := s.backupEnv(ctx, host, dir); err != nil {
			return domain.Result{}, err
		}
		if err := host.WriteFileAtomic(ctx, envPath(dir), updated, 0o600); err != nil {
			return domain.Result{}, err
		}
	}

	if err := engine.Apply(ctx, host, dir); err != nil {
		return domain.Result{}, err
	}
	if err := s.waitHealthy(ctx, target, plan.Secrets); err != nil {
		return domain.Result{}, err
	}
	return domain.Result{State: "published", VersionID: snapshot.VersionID}, nil
}

// RestorePrevious copies .env.bak back over .env and restarts the container.
// The backup is kept so the user can retry.
func (s *Service) RestorePrevious(ctx context.Context, target domain.Target) (domain.Result, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	host, err := s.dial(target)
	if err != nil {
		return domain.Result{}, err
	}
	dir := target.Host.Dir
	engine := s.engine(target)
	if _, err := readFileOnHost(ctx, host, backupPath(dir)); err != nil {
		if errors.Is(err, hostexec.ErrNotExist) {
			return domain.Result{}, invalidRequest("the remote directory has no .env.bak")
		}
		return domain.Result{}, err
	}

	cpCtx, cancelCopy := context.WithTimeout(ctx, commandTimeout)
	copied, err := host.Run(cpCtx, fmt.Sprintf("cp -p %s %s",
		hostexec.QuotePath(backupPath(dir)), hostexec.QuotePath(envPath(dir))), nil)
	cancelCopy()
	if err != nil {
		return domain.Result{}, err
	}
	if copied.ExitCode != 0 {
		return domain.Result{}, domain.Error{Code: domain.NOT_SENT, Message: outputMessage(copied)}
	}
	if err := engine.Apply(ctx, host, dir); err != nil {
		return domain.Result{}, err
	}
	if err := s.waitHealthy(ctx, target, nil); err != nil {
		return domain.Result{}, err
	}

	snapshot, err := s.ReadSnapshot(ctx, target)
	if err != nil {
		return domain.Result{}, err
	}
	return domain.Result{State: "published", VersionID: snapshot.VersionID}, nil
}

// readEnvelope reads and parses the remote .env in one pass.
func (s *Service) readEnvelope(ctx context.Context, host Host, dir string, engine Engine) ([]byte, *envfile.File, error) {
	readCtx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	data, err := host.ReadFile(readCtx, envPath(dir))
	if err != nil {
		if errors.Is(err, hostexec.ErrNotExist) {
			return nil, nil, envFileError("the remote .env file is missing")
		}
		return nil, nil, err
	}
	file, err := envfile.ParseDialect(data, engine.Dialect())
	if err != nil {
		return nil, nil, envFileError("the remote .env file cannot be parsed")
	}
	return data, file, nil
}

func (s *Service) backupEnv(ctx context.Context, host Host, dir string) error {
	cpCtx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	copied, err := host.Run(cpCtx, fmt.Sprintf("cp -p %s %s",
		hostexec.QuotePath(envPath(dir)), hostexec.QuotePath(backupPath(dir))), nil)
	if err != nil {
		return err
	}
	if copied.ExitCode != 0 {
		return domain.Error{Code: domain.NOT_SENT, Message: outputMessage(copied)}
	}
	return nil
}

// applyPlan mutates the parsed file in memory. Nothing is written until every
// edit has been accepted.
func applyPlan(file *envfile.File, plan domain.PublishPlan) error {
	for _, edit := range plan.Secrets {
		if !Allowed(edit.Name) {
			return secretEditError("not a writable secret name: " + edit.Name)
		}
		switch edit.Operation {
		case domain.SecretReplace:
			if err := setEnvValue(file, edit.Name, edit.Value()); err != nil {
				return err
			}
		case domain.SecretClear:
			file.Delete(edit.Name)
		}
	}
	for name, value := range plan.Vars {
		if !Allowed(name) {
			return secretEditError("not a writable variable name: " + name)
		}
		if err := setEnvValue(file, name, value); err != nil {
			return err
		}
	}

	configText, err := compactConfig(plan.ConfigJSON)
	if err != nil {
		return err
	}
	if configText == "" {
		return nil
	}
	return setEnvValue(file, "DESKWAND_CONFIG", configText)
}

func compactConfig(raw []byte) (string, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return "", nil
	}
	var buffer bytes.Buffer
	if err := json.Compact(&buffer, raw); err != nil {
		return "", envFileError("DESKWAND_CONFIG is not valid JSON")
	}
	return buffer.String(), nil
}

func setEnvValue(file *envfile.File, name, value string) error {
	if err := file.Set(name, value); err != nil {
		if errors.Is(err, envfile.ErrUnrepresentable) {
			return envFileError("a value cannot be written safely")
		}
		return secretEditError("invalid .env key: " + name)
	}
	return nil
}

func secretEditError(message string) error {
	return domain.Error{Code: domain.INVALID_SECRET_EDIT, Message: message}
}

func outputMessage(result hostexec.Result) string {
	message := lastLines(result.Stderr, 20)
	if message == "" {
		message = lastLines(result.Stdout, 20)
	}
	return message
}
