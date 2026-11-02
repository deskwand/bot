package backup

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
)

const (
	defaultReadyTimeout = 60 * time.Second
	// readyPollInterval is the pause between probes while a freshly published
	// ADMIN_TOKEN propagates to the Worker.
	readyPollInterval = 2 * time.Second
	unknownRelease    = "unknown"
)

// Progress phases reported while an operation runs.
const (
	PhasePreparing = "preparing"
	PhaseDatabase  = "database"
	PhaseObjects   = "objects"
	PhaseFinishing = "finishing"
	PhaseClearing  = "clearing"
)

// Progress is one snapshot of an export or restore operation, passed only to
// the local UI.
type Progress struct {
	Op           string `json:"op"`
	Phase        string `json:"phase"`
	Tables       int    `json:"tables"`
	Rows         int64  `json:"rows"`
	Objects      int    `json:"objects"`
	TotalObjects int    `json:"totalObjects"`
}

// Deps are the services the export and restore flows need. Every field except
// Token has a default, so tests can replace only what they observe.
type Deps struct {
	Token        TokenDeps
	HTTP         *http.Client
	Now          func() time.Time
	NewOpID      func() (string, error)
	Progress     func(Progress)
	ReadyTimeout time.Duration
}

func (d Deps) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

func (d Deps) newOpID() (string, error) {
	if d.NewOpID != nil {
		return d.NewOpID()
	}
	var random [16]byte
	if _, err := io.ReadFull(rand.Reader, random[:]); err != nil {
		return "", fmt.Errorf("backup: generate operation id: %w", err)
	}
	return "op-" + hex.EncodeToString(random[:]), nil
}

func (d Deps) readyTimeout() time.Duration {
	if d.ReadyTimeout > 0 {
		return d.ReadyTimeout
	}
	return defaultReadyTimeout
}

// pollInterval keeps the propagation wait responsive in tests that inject a
// short ReadyTimeout.
func (d Deps) pollInterval() time.Duration {
	interval := d.readyTimeout() / 10
	if interval > readyPollInterval {
		return readyPollInterval
	}
	if interval < 10*time.Millisecond {
		return 10 * time.Millisecond
	}
	return interval
}

func (d Deps) report(progress Progress) {
	if d.Progress != nil {
		d.Progress(progress)
	}
}

// Export writes every Durable Object table and R2 object of target into path.
// The archive only appears at path once it is complete; a failure removes the
// temporary file and releases the maintenance lease.
func Export(ctx context.Context, deps Deps, target domain.Target, path string) (Manifest, error) {
	deps.report(Progress{Op: "export", Phase: PhasePreparing})

	opID, err := deps.newOpID()
	if err != nil {
		return Manifest{}, err
	}
	client, snapshot, published, err := connectFor(ctx, deps, target, opID)
	if err != nil {
		return Manifest{}, err
	}

	client, err = acquireLease(ctx, deps, target, client, published, "export")
	if err != nil {
		return Manifest{}, err
	}
	released := false
	release := func() {
		if released {
			return
		}
		released = true
		_ = releaseLease(client)
	}
	defer release()

	writer, err := NewWriter(path)
	if err != nil {
		return Manifest{}, err
	}
	defer writer.Abort()

	manifest, err := exportData(ctx, deps, client, snapshot, target, writer)
	if err != nil {
		return Manifest{}, err
	}

	deps.report(Progress{
		Op:           "export",
		Phase:        PhaseFinishing,
		Tables:       tablesExported(manifest),
		Rows:         rowsExported(manifest),
		Objects:      len(manifest.R2.Objects),
		TotalObjects: len(manifest.R2.Objects),
	})
	release()
	if err := writer.Finish(manifest); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

// connect builds the admin client for target and waits for a freshly published
// ADMIN_TOKEN to reach the Worker.
func connect(ctx context.Context, deps Deps, target domain.Target, opID string) (*AdminClient, domain.Snapshot, error) {
	client, snapshot, _, err := connectFor(ctx, deps, target, opID)
	return client, snapshot, err
}

func connectFor(ctx context.Context, deps Deps, target domain.Target, opID string) (*AdminClient, domain.Snapshot, bool, error) {
	snapshot, err := deps.Token.Snapshots.ReadSnapshot(ctx, target)
	if err != nil {
		return nil, domain.Snapshot{}, false, err
	}
	baseURL := publicBaseURL(snapshot.SettingsJSON)
	if baseURL == "" {
		return nil, snapshot, false, domain.Error{
			Code:    CodeAdminUnavailable,
			Message: "deployment settings do not declare PUBLIC_BASE_URL",
		}
	}
	token, published, err := EnsureAdminToken(ctx, deps.Token, target)
	if err != nil {
		return nil, snapshot, false, err
	}
	client := NewAdminClient(baseURL, token, opID, deps.HTTP)
	if published {
		if err := waitForAdmin(ctx, deps, client); err != nil {
			return nil, snapshot, published, err
		}
	}
	return client, snapshot, published, nil
}

// waitForAdmin polls Info until the Worker answers for the new token. A 409
// MAINTENANCE_REQUIRED already proves the route and token are live.
func waitForAdmin(ctx context.Context, deps Deps, client *AdminClient) error {
	deadline := time.Now().Add(deps.readyTimeout())
	interval := deps.pollInterval()
	for {
		_, err := client.Info(ctx)
		if err == nil || errorCode(err) != CodeAdminUnavailable {
			return nil
		}
		if !time.Now().Before(deadline) {
			return err
		}
		if err := sleepContext(ctx, interval); err != nil {
			return err
		}
	}
}

// acquireLease takes the maintenance lease. It retries a 404 while a freshly
// published secret propagates and republishes the token once after a 401.
func acquireLease(ctx context.Context, deps Deps, target domain.Target, client *AdminClient, published bool, op string) (*AdminClient, error) {
	deadline := time.Now().Add(deps.readyTimeout())
	interval := deps.pollInterval()
	retryUnavailable := published
	republished := false
	for {
		err := client.Acquire(ctx, op)
		if err == nil {
			return client, nil
		}
		switch errorCode(err) {
		case CodeAdminUnauthorized:
			if republished {
				return client, err
			}
			republished = true
			retryUnavailable = true
			token, republishErr := RepublishAdminToken(ctx, deps.Token, target)
			if republishErr != nil {
				return client, republishErr
			}
			client = NewAdminClient(client.baseURL, token, client.opID, deps.HTTP)
		case CodeAdminUnavailable:
			if !retryUnavailable {
				return client, err
			}
		default:
			return client, err
		}
		if !time.Now().Before(deadline) {
			return client, err
		}
		if err := sleepContext(ctx, interval); err != nil {
			return client, err
		}
	}
}

// releaseLease releases the lease on a context that survives cancellation, so
// a failed export still lets the bot resume immediately.
func releaseLease(client *AdminClient) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(context.Background()), 30*time.Second)
	defer cancel()
	return client.Release(ctx)
}

func exportData(ctx context.Context, deps Deps, client *AdminClient, snapshot domain.Snapshot, target domain.Target, writer *Writer) (Manifest, error) {
	info, err := client.Info(ctx)
	if err != nil {
		return Manifest{}, err
	}

	manifest := Manifest{
		Format:     FormatVersion,
		ExportedAt: deps.now().UTC(),
		Release:    releaseOrUnknown(snapshot.ReleaseVersion),
		VersionID:  info.VersionID,
		WorkerName: target.ScriptName,
	}

	progress := Progress{Op: "export", Phase: PhaseDatabase}
	deps.report(progress)
	for _, ref := range exportRefs(info.TaskIDs) {
		object, err := exportDurableObject(ctx, client, writer, ref, &progress, deps)
		if err != nil {
			return Manifest{}, err
		}
		manifest.DurableObjects = append(manifest.DurableObjects, object)
	}

	progress.Phase = PhaseObjects
	progress.Tables = tablesExported(manifest)
	progress.Rows = rowsExported(manifest)
	deps.report(progress)

	objects, err := client.ListObjects(ctx)
	if err != nil {
		return Manifest{}, err
	}
	progress.TotalObjects = len(objects)
	deps.report(progress)

	r2, err := exportObjects(ctx, deps, client, writer, objects, &progress)
	if err != nil {
		return Manifest{}, err
	}
	manifest.R2 = r2
	return manifest, nil
}

// exportRefs lists the objects in export order: the Butler, every task, then
// the channel hub.
func exportRefs(taskIDs []string) []DORef {
	refs := make([]DORef, 0, len(taskIDs)+2)
	refs = append(refs, DORef{DO: "butler"})
	for _, id := range taskIDs {
		refs = append(refs, DORef{DO: "task", ID: id})
	}
	return append(refs, DORef{DO: "channel"})
}

func exportDurableObject(ctx context.Context, client *AdminClient, writer *Writer, ref DORef, progress *Progress, deps Deps) (DOManifest, error) {
	object := DOManifest{
		DORef: ref,
		Rows:  map[string]int64{},
	}
	schema, err := client.Schema(ctx, ref)
	if err != nil {
		return DOManifest{}, err
	}
	object.Schema = schema
	for _, table := range schema.Tables {
		tableWriter, err := writer.Table(ref, table.Name)
		if err != nil {
			return DOManifest{}, err
		}
		var cursor *string
		for {
			rows, next, err := client.Page(ctx, ref, table, cursor)
			if err != nil {
				return DOManifest{}, err
			}
			if err := tableWriter.Append(rows); err != nil {
				return DOManifest{}, err
			}
			progress.Rows += int64(len(rows))
			cursor = next
			if cursor == nil {
				break
			}
		}
		object.Rows[table.Name] = tableWriter.Rows()
		progress.Tables++
		deps.report(*progress)
	}
	return object, nil
}

func exportObjects(ctx context.Context, deps Deps, client *AdminClient, writer *Writer, objects []ObjectInfo, progress *Progress) (R2Manifest, error) {
	manifest := R2Manifest{Objects: []R2Item{}, Oversized: []string{}}
	for _, object := range objects {
		if object.Size > MaxR2ObjectBytes {
			// The Worker cannot accept this object back, so keeping its bytes
			// would only produce a backup that cannot be restored. Record the
			// key so the restore step can refuse the file with an explanation.
			manifest.Oversized = append(manifest.Oversized, object.Key)
			progress.Objects++
			deps.report(*progress)
			continue
		}
		body, err := client.GetObject(ctx, object.Key)
		if err != nil {
			return R2Manifest{}, err
		}
		item := R2Item{
			Key:         object.Key,
			Entry:       ObjectEntry(len(manifest.Objects) + 1),
			Size:        object.Size,
			ContentType: object.ContentType,
		}
		err = writer.Object(item, body)
		_ = body.Close()
		if err != nil {
			return R2Manifest{}, err
		}
		manifest.Objects = append(manifest.Objects, item)
		manifest.Bytes += item.Size
		progress.Objects++
		deps.report(*progress)
	}
	return manifest, nil
}

func releaseOrUnknown(release string) string {
	if release == "" {
		return unknownRelease
	}
	return release
}

func tablesExported(manifest Manifest) int {
	tables := 0
	for _, object := range manifest.DurableObjects {
		tables += len(object.Rows)
	}
	return tables
}

func rowsExported(manifest Manifest) int64 {
	var rows int64
	for _, object := range manifest.DurableObjects {
		for _, count := range object.Rows {
			rows += count
		}
	}
	return rows
}

func errorCode(err error) string {
	var coded domain.Error
	if errors.As(err, &coded) {
		return coded.Code
	}
	return ""
}

func sleepContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// publicBaseURL mirrors app.ReadPlainVar for the one binding the backup flow
// needs. It lives here so the backup package does not depend on the app layer.
func publicBaseURL(settingsJSON []byte) string {
	if len(settingsJSON) == 0 {
		return ""
	}
	var document struct {
		Bindings []struct {
			Name string `json:"name"`
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"bindings"`
	}
	if err := json.Unmarshal(settingsJSON, &document); err != nil {
		return ""
	}
	for _, binding := range document.Bindings {
		if binding.Type == "plain_text" && binding.Name == "PUBLIC_BASE_URL" {
			return strings.TrimRight(binding.Text, "/")
		}
	}
	return ""
}
