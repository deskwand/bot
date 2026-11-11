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
	"sync"
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

// renewEveryBytes is the artifact size above which a transfer renews the
// maintenance lease. Tests lower it to avoid allocating a large object.
var renewEveryBytes int64 = 10 << 20

// leaseHeartbeatInterval is how often a long export or restore renews the
// lease in the background. A failed renewal cancels the operation before it
// can overlap a second client.
var leaseHeartbeatInterval = time.Minute

// maxArchivedObjects keeps ObjectEntry at six digits. Reaching one million
// artifacts would produce r2/1000000, which this client refuses to read.
const maxArchivedObjects = 999_999

// TargetLocker is the shared per-deployment lock used by publish, install,
// upgrade and the destructive restore path.
type TargetLocker interface {
	Lock(ctx context.Context, target domain.Target) (func(), error)
}

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
	Locker       TargetLocker
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
	client, snapshot, published, err := connect(ctx, deps, target, opID)
	if err != nil {
		return Manifest{}, err
	}

	writer, err := NewWriter(path)
	if err != nil {
		return Manifest{}, err
	}
	defer writer.Abort()

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

	// Serialize with publish/upgrade. The token was established above, so this
	// lock never wraps Publisher.Apply (which takes the same non-reentrant
	// lock through the deployment service).
	unlock, err := lockTarget(ctx, deps, target)
	if err != nil {
		return Manifest{}, err
	}
	defer unlock()

	var manifest Manifest
	err = withLeaseHeartbeat(ctx, client, func(heartbeatCtx context.Context) error {
		var exportErr error
		manifest, exportErr = exportData(heartbeatCtx, deps, client, snapshot, target, writer)
		return exportErr
	})
	if err != nil {
		return Manifest{}, err
	}

	listed := len(manifest.R2.Objects) + len(manifest.R2.Oversized)
	deps.report(Progress{
		Op:           "export",
		Phase:        PhaseFinishing,
		Tables:       tablesExported(manifest),
		Rows:         rowsExported(manifest),
		Objects:      listed,
		TotalObjects: listed,
	})
	release()
	if err := writer.Finish(manifest); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

// connect builds the admin client for target and waits for a freshly published
// ADMIN_TOKEN to reach the Worker. The returned flag reports whether this call
// published the secret, so the caller knows it may need to wait for a 404 to
// clear before acquiring the lease.
func connect(ctx context.Context, deps Deps, target domain.Target, opID string) (*AdminClient, domain.Snapshot, bool, error) {
	snapshot, err := deps.Token.Snapshots.ReadSnapshot(ctx, target)
	if err != nil {
		return nil, domain.Snapshot{}, false, err
	}
	baseURL := PublicBaseURL(snapshot.SettingsJSON)
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
		if err := WaitForAdmin(ctx, deps, client); err != nil {
			return nil, snapshot, published, err
		}
	}
	return client, snapshot, published, nil
}

// WaitForAdmin polls Info until the Worker answers for the new token. A 409
// MAINTENANCE_REQUIRED or a 401 already proves the route and token are live;
// a 404 or a transient failure may still clear before the deadline.
func WaitForAdmin(ctx context.Context, deps Deps, client *AdminClient) error {
	deadline := time.Now().Add(deps.readyTimeout())
	interval := deps.pollInterval()
	for {
		_, err := client.Info(ctx)
		if err == nil || readyError(err) {
			return nil
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		if !retryableReadyError(err) {
			return err
		}
		if !time.Now().Before(deadline) {
			return err
		}
		if err := sleepContext(ctx, interval); err != nil {
			return err
		}
	}
}

func readyError(err error) bool {
	switch errorCode(err) {
	case CodeAdminUnauthorized, CodeMaintenanceRequired:
		return true
	default:
		return false
	}
}

func retryableReadyError(err error) bool {
	switch errorCode(err) {
	case CodeAdminUnavailable, CodeBackupInvalid:
		// ADMIN_UNAVAILABLE is the propagation window; BACKUP_INVALID is what
		// the client reports for an unmapped status, including a 5xx while the
		// new version starts serving.
		return true
	default:
		return false
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
			// The old deadline may have been spent while the secret was
			// published. Give the new token at least one full window.
			deadline = time.Now().Add(deps.readyTimeout())
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

// renewLease extends an existing lease. It uses a lease-checked Info request
// rather than Acquire: an expired lease must fail instead of being silently
// re-taken while another client may already hold it.
func renewLease(ctx context.Context, client *AdminClient) error {
	_, err := client.Info(ctx)
	return err
}

// withLeaseHeartbeat renews in the background and cancels fn as soon as the
// lease is lost. A large R2 transfer therefore stops instead of writing into
// a deployment another operation may have taken over.
func withLeaseHeartbeat(ctx context.Context, client *AdminClient, fn func(context.Context) error) error {
	child, cancel := context.WithCancel(ctx)
	defer cancel()

	done := make(chan struct{})
	var mu sync.Mutex
	var heartbeatErr error
	go func() {
		ticker := time.NewTicker(leaseHeartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-child.Done():
				return
			case <-ticker.C:
				if err := renewLease(child, client); err != nil {
					mu.Lock()
					heartbeatErr = err
					mu.Unlock()
					cancel()
					return
				}
			}
		}
	}()

	err := fn(child)
	close(done)
	mu.Lock()
	deferred := heartbeatErr
	mu.Unlock()
	if deferred != nil {
		return deferred
	}
	return err
}

func lockTarget(ctx context.Context, deps Deps, target domain.Target) (func(), error) {
	if deps.Locker == nil {
		return func() {}, nil
	}
	return deps.Locker.Lock(ctx, target)
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
	for _, ref := range exportRefs(info.TaskIDs, info.BotIDs) {
		object, err := exportDurableObject(ctx, client, writer, ref, &progress, deps)
		if err != nil {
			// A Worker that predates the ledger rejects do=life. Back it up
			// without a ledger instead of failing the whole export.
			if ref.DO == "life" && unknownDOKind(err, ref) {
				continue
			}
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

	r2, err := exportObjects(ctx, deps, client, writer, objects, &progress, "export")
	if err != nil {
		return Manifest{}, err
	}
	manifest.R2 = r2
	return manifest, nil
}

// exportRefs lists the objects in export order: tasks first, then bots, the
// life ledger, the channel hub, and the Butler last. A delivered task event is
// therefore either in both the TaskDO and the Butler, or in the TaskDO with
// delivered = 0 (which the Butler dedupes on restore). A bot is archived after
// the tasks it points at, and the Butler is never archived before the task and
// bot copies it indexes.
func exportRefs(taskIDs, botIDs []string) []DORef {
	refs := make([]DORef, 0, len(taskIDs)+len(botIDs)+3)
	for _, id := range taskIDs {
		refs = append(refs, DORef{DO: "task", ID: id})
	}
	for _, id := range botIDs {
		refs = append(refs, DORef{DO: "bot", ID: id})
	}
	refs = append(refs, DORef{DO: "life"})
	refs = append(refs, DORef{DO: "channel"})
	return append(refs, DORef{DO: "butler"})
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
			deps.report(*progress)
			if next == nil {
				break
			}
			if cursor != nil && *next == *cursor {
				return DOManifest{}, invalidBackupf("page cursor did not advance for table %s", table.Name)
			}
			cursor = next
		}
		object.Rows[table.Name] = tableWriter.Rows()
		progress.Tables++
		deps.report(*progress)
	}
	return object, nil
}

func exportObjects(ctx context.Context, deps Deps, client *AdminClient, writer *Writer, objects []ObjectInfo, progress *Progress, op string) (R2Manifest, error) {
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
		entry, err := checkedObjectEntry(len(manifest.Objects) + 1)
		if err != nil {
			return R2Manifest{}, err
		}
		item := R2Item{
			Key:         object.Key,
			Entry:       entry,
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
		if item.Size > renewEveryBytes {
			if err := renewLease(ctx, client); err != nil {
				return R2Manifest{}, err
			}
		}
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

// PublicBaseURL mirrors app.ReadPlainVar for the one binding the backup flow
// needs. It lives here so the backup package does not depend on the app layer.
func PublicBaseURL(settingsJSON []byte) string {
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
