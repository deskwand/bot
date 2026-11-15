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
	"os"
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

// batchBytes is the byte budget of one chunked read. Tests lower it to force
// several batches out of a small fixture.
var batchBytes = 4 << 20

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

// EndpointResolver turns a target into an admin surface. This package cannot
// import adminendpoint (that package imports backup), so the interface speaks
// in plain values and the app layer adapts it.
type EndpointResolver interface {
	ResolveEndpoint(ctx context.Context, target domain.Target) (baseURL, token string, httpClient *http.Client, err error)
}

// EndpointRefresher is the optional half of a resolver that can replace a
// rejected admin credential, which only a Worker can do. A container's token
// lives in its .env and cannot be republished from here.
type EndpointRefresher interface {
	RefreshEndpoint(ctx context.Context, target domain.Target) (baseURL, token string, httpClient *http.Client, err error)
}

// Deps are the services the export and restore flows need. Every field except
// Endpoints and Snapshots has a default, so tests can replace only what they
// observe.
type Deps struct {
	Endpoints    EndpointResolver
	Snapshots    SnapshotReader
	HTTP         *http.Client
	Locker       TargetLocker
	Now          func() time.Time
	NewOpID      func() (string, error)
	Progress     func(Progress)
	ReadyTimeout time.Duration
	// ResumeDir keeps a failed export's progress. Empty writes the checkpoint
	// into a temporary directory that is always removed, which is what the
	// pre-restore snapshot needs.
	ResumeDir string
	// Logf records one diagnostic line per admin round trip. Nil disables it.
	Logf func(format string, args ...any)
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

func (d Deps) logf(format string, args ...any) {
	if d.Logf != nil {
		d.Logf(format, args...)
	}
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
	client, snapshot, err := connect(ctx, deps, target, opID)
	if err != nil {
		return Manifest{}, err
	}

	checkpointDir := ""
	_, targetKey := checkpointPath("", target)
	if deps.ResumeDir == "" {
		temp, err := os.MkdirTemp("", "deskwand-backup-")
		if err != nil {
			return Manifest{}, fmt.Errorf("backup: create checkpoint: %w", err)
		}
		checkpointDir = temp
	} else {
		checkpointDir, targetKey = checkpointPath(deps.ResumeDir, target)
	}
	checkpoint, err := OpenCheckpoint(checkpointDir, targetKey)
	if err != nil {
		if deps.ResumeDir == "" {
			_ = os.RemoveAll(checkpointDir)
		}
		return Manifest{}, err
	}
	if deps.ResumeDir == "" {
		// Nothing to resume into: the snapshot case must not leave state
		// behind, whether it succeeds or fails.
		defer func() { _ = checkpoint.Discard() }()
	}

	client, err = acquireLease(ctx, deps, target, client, "export")
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
		manifest, exportErr = exportData(heartbeatCtx, deps, client, snapshot, target, checkpoint)
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
	if err := finalizeArchive(checkpoint, path, manifest); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

// finalizeArchive turns the checkpoint into the archive at path, validates it
// with the reader a restore uses, then removes the checkpoint.
func finalizeArchive(checkpoint *Checkpoint, path string, manifest Manifest) error {
	writer, err := NewWriter(path)
	if err != nil {
		return err
	}
	defer writer.Abort()

	for _, object := range manifest.DurableObjects {
		ref := object.DORef
		for _, table := range object.Schema.Tables {
			body, err := checkpoint.ReadTable(ref, table.Name)
			if err != nil {
				return fmt.Errorf("backup: read checkpoint table %s: %w", table.Name, err)
			}
			err = writer.Entry(TableEntry(ref, table.Name), body)
			_ = body.Close()
			if err != nil {
				return err
			}
		}
	}
	for _, item := range manifest.R2.Objects {
		if !checkpoint.HasObject(item.Entry) {
			return invalidBackupf("artifact %s is missing from the checkpoint", item.Entry)
		}
		body, err := checkpoint.ReadObject(item.Entry)
		if err != nil {
			return fmt.Errorf("backup: read checkpoint artifact: %w", err)
		}
		err = writer.Entry(item.Entry, body)
		_ = body.Close()
		if err != nil {
			return err
		}
	}
	if err := writer.Finish(manifest); err != nil {
		return err
	}
	if err := verifyArchiveEntries(path, manifest); err != nil {
		// A checkpoint that cannot produce a valid archive is worse than no
		// checkpoint: every later run would fail on it without progress.
		_ = checkpoint.Discard()
		return err
	}
	return checkpoint.Discard()
}

// recordSchema stores a DO's schema before any of its rows are written, so a
// run that dies mid-DO still leaves the shape its finished tables were read
// with.
func recordSchema(checkpoint *Checkpoint, ref DORef, schema DBSchema) error {
	state := checkpoint.State()
	if _, seen := state.Schemas[doKeyOf(ref)]; seen {
		return nil
	}
	state.Schemas[doKeyOf(ref)] = schema
	return checkpoint.Save(state)
}

// schemaDrifted reports whether any table that already finished changed shape.
// A DO the deployment no longer has cannot drift; its rows are simply not
// exported this time.
func schemaDrifted(ctx context.Context, client *AdminClient, checkpoint *Checkpoint, refs []DORef) (bool, error) {
	recorded := checkpoint.State().Schemas
	if len(recorded) == 0 {
		return false, nil
	}
	for _, ref := range refs {
		if _, seen := recorded[doKeyOf(ref)]; !seen {
			continue
		}
		schema, err := client.Schema(ctx, ref)
		if err != nil {
			if (ref.DO == "life" || ref.DO == "wallet") && unknownDOKind(err, ref) {
				continue
			}
			return false, err
		}
		if checkpoint.NeedsReset(ref, schema) {
			return true, nil
		}
	}
	return false, nil
}

// connect builds the admin client for target. The resolver owns the credential
// flow, so this package never reads PUBLIC_BASE_URL or publishes a secret.
func connect(ctx context.Context, deps Deps, target domain.Target, opID string) (*AdminClient, domain.Snapshot, error) {
	if deps.Endpoints == nil || deps.Snapshots == nil {
		return nil, domain.Snapshot{}, domain.Error{Code: CodeAdminUnavailable, Message: "the backup endpoint is not wired"}
	}
	snapshot, err := deps.Snapshots.ReadSnapshot(ctx, target)
	if err != nil {
		return nil, domain.Snapshot{}, err
	}
	client, err := newClient(ctx, deps, target, opID)
	if err != nil {
		return nil, snapshot, err
	}
	return client, snapshot, nil
}

// newClientWith builds a client from one resolve function, so the refresh path
// and the normal path share the same plumbing.
func newClientWith(
	ctx context.Context,
	deps Deps,
	target domain.Target,
	opID string,
	resolve func(context.Context, domain.Target) (string, string, *http.Client, error),
) (*AdminClient, error) {
	baseURL, token, httpClient, err := resolve(ctx, target)
	if err != nil {
		return nil, err
	}
	if httpClient == nil {
		httpClient = deps.HTTP
	}
	return NewAdminClient(baseURL, token, opID, httpClient), nil
}

// newClient resolves the endpoint and returns a client for it.
func newClient(ctx context.Context, deps Deps, target domain.Target, opID string) (*AdminClient, error) {
	return newClientWith(ctx, deps, target, opID, deps.Endpoints.ResolveEndpoint)
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

// acquireLease takes the maintenance lease. A 401 is retried once through the
// resolver's refresher: the deployment may have been replaced by a version
// that lost the ADMIN_TOKEN binding.
func acquireLease(ctx context.Context, deps Deps, target domain.Target, client *AdminClient, op string) (*AdminClient, error) {
	deadline := time.Now().Add(deps.readyTimeout())
	interval := deps.pollInterval()
	refreshed := false
	for {
		err := client.Acquire(ctx, op)
		if err == nil {
			return client, nil
		}
		switch errorCode(err) {
		case CodeAdminUnauthorized:
			refresher, ok := deps.Endpoints.(EndpointRefresher)
			if refreshed || !ok {
				return client, err
			}
			refreshed = true
			fresh, refreshErr := newClientWith(ctx, deps, target, client.opID, refresher.RefreshEndpoint)
			if refreshErr != nil {
				return client, refreshErr
			}
			client = fresh
			// The old deadline may have been spent while the credential was
			// republished. Give the new token at least one full window.
			deadline = time.Now().Add(deps.readyTimeout())
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

func exportData(ctx context.Context, deps Deps, client *AdminClient, snapshot domain.Snapshot, target domain.Target, checkpoint *Checkpoint) (Manifest, error) {
	info, err := client.Info(ctx)
	if err != nil {
		return Manifest{}, err
	}

	state := checkpoint.State()
	resumed := len(state.Tables) > 0
	if state.StartedAt.IsZero() {
		state.StartedAt = deps.now().UTC()
		if err := checkpoint.Save(state); err != nil {
			return Manifest{}, err
		}
	}
	refs := exportRefs(info.TaskIDs, info.BotIDs, info.MemberIDs)
	// A changed table shape voids the checkpoint. Deciding this before reading
	// anything keeps a reset from discarding tables this run already finished.
	if resumed {
		drift, err := schemaDrifted(ctx, client, checkpoint, refs)
		if err != nil {
			return Manifest{}, err
		}
		if drift {
			if err := checkpoint.Reset(); err != nil {
				return Manifest{}, err
			}
			state := checkpoint.State()
			state.StartedAt = deps.now().UTC()
			if err := checkpoint.Save(state); err != nil {
				return Manifest{}, err
			}
			resumed = false
		}
	}

	manifest := Manifest{
		Format:     FormatVersion,
		StartedAt:  checkpoint.State().StartedAt,
		Resumed:    resumed,
		ExportedAt: deps.now().UTC(),
		Release:    releaseOrUnknown(snapshot.ReleaseVersion),
		VersionID:  info.VersionID,
		WorkerName: target.ScriptName,
	}

	progress := Progress{Op: "export", Phase: PhaseDatabase}
	deps.report(progress)
	for _, ref := range refs {
		object, err := exportDurableObjectBatched(ctx, client, checkpoint, ref, &progress, deps)
		if err != nil {
			// A Worker that predates the ledger or the wallet rejects that
			// kind. Back it up without it instead of failing the whole export.
			if (ref.DO == "life" || ref.DO == "wallet") && unknownDOKind(err, ref) {
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

	r2, err := exportObjects(ctx, deps, client, checkpoint, &progress, "export")
	if err != nil {
		return Manifest{}, err
	}
	manifest.R2 = r2
	return manifest, nil
}

// exportRefs lists the objects in export order: tasks first, then bots, the
// life ledger, the wallet, the channel hub, and the Butler last. A delivered
// task event is therefore either in both the TaskDO and the Butler, or in the
// TaskDO with delivered = 0 (which the Butler dedupes on restore). A bot is
// archived after the tasks it points at, and the Butler is never archived
// before the task and bot copies it indexes.
func exportRefs(taskIDs, botIDs, memberIDs []string) []DORef {
	refs := make([]DORef, 0, len(taskIDs)+len(botIDs)+len(memberIDs)+4)
	for _, id := range taskIDs {
		refs = append(refs, DORef{DO: "task", ID: id})
	}
	for _, id := range botIDs {
		refs = append(refs, DORef{DO: "bot", ID: id})
	}
	for _, id := range memberIDs {
		refs = append(refs, DORef{DO: "butler", ID: id})
	}
	refs = append(refs, DORef{DO: "life"})
	refs = append(refs, DORef{DO: "wallet"})
	refs = append(refs, DORef{DO: "channel"})
	return append(refs, DORef{DO: "butler"})
}

func exportDurableObjectPaged(ctx context.Context, client *AdminClient, checkpoint *Checkpoint, ref DORef, schema DBSchema, progress *Progress, deps Deps) (DOManifest, error) {
	if err := recordSchema(checkpoint, ref, schema); err != nil {
		return DOManifest{}, err
	}
	object := DOManifest{
		DORef:  ref,
		Schema: schema,
		Rows:   map[string]int64{},
	}
	for _, table := range schema.Tables {
		if checkpoint.HasTable(ref, table.Name) {
			object.Rows[table.Name] = checkpoint.TableRows(ref, table.Name)
			continue
		}
		rows := 0
		var cursor *string
		for {
			started := time.Now()
			page, next, err := client.Page(ctx, ref, table, cursor)
			deps.logf(
				"page do=%s id=%s table=%s rows=%d next=%v ms=%d",
				ref.DO, ref.ID, table.Name, len(page), next != nil, time.Since(started).Milliseconds(),
			)
			if err != nil {
				return DOManifest{}, err
			}
			if err := checkpoint.AppendTable(ref, table.Name, page, next == nil); err != nil {
				return DOManifest{}, err
			}
			rows += len(page)
			progress.Rows += int64(len(page))
			deps.report(*progress)
			if next == nil {
				break
			}
			if cursor != nil && *next == *cursor {
				return DOManifest{}, invalidBackupf("page cursor did not advance for table %s", table.Name)
			}
			cursor = next
		}
		object.Rows[table.Name] = int64(rows)
		progress.Tables++
		deps.report(*progress)
	}
	deps.logf("paged do=%s id=%s tables=%d", ref.DO, ref.ID, len(object.Rows))
	return object, nil
}

// exportDurableObjectBatched reads every table of one DO through the chunk
// route. Tables a previous run finished are taken from the checkpoint, so their
// rows are never read again. The chunk route is newer than the oldest supported
// Worker, so a 404 falls back to the per-page export before anything is written.
func exportDurableObjectBatched(ctx context.Context, client *AdminClient, checkpoint *Checkpoint, ref DORef, progress *Progress, deps Deps) (DOManifest, error) {
	schema, err := client.Schema(ctx, ref)
	if err != nil {
		return DOManifest{}, err
	}
	if err := recordSchema(checkpoint, ref, schema); err != nil {
		return DOManifest{}, err
	}
	object := DOManifest{DORef: ref, Schema: schema, Rows: map[string]int64{}}

	pending := make([]TableSchema, 0, len(schema.Tables))
	for _, table := range schema.Tables {
		if checkpoint.HasTable(ref, table.Name) {
			object.Rows[table.Name] = checkpoint.TableRows(ref, table.Name)
			continue
		}
		pending = append(pending, table)
	}
	if len(pending) == 0 {
		deps.logf("chunk do=%s id=%s resumed=%d ms=0", ref.DO, ref.ID, len(schema.Tables))
		return object, nil
	}

	state := BatchState{}
	closed := map[string]bool{}
	wrote := false

	for {
		started := time.Now()
		result, err := client.Batch(ctx, ref, pending, state, batchBytes)
		if err != nil {
			if errorCode(err) == CodeAdminUnavailable && !wrote {
				return exportDurableObjectPaged(ctx, client, checkpoint, ref, schema, progress, deps)
			}
			return DOManifest{}, err
		}
		if len(result.Chunks) > 0 {
			wrote = true
		}

		rows := 0
		for _, chunk := range result.Chunks {
			if closed[chunk.Table] {
				return DOManifest{}, invalidBackupf("table %s was returned after it finished", chunk.Table)
			}
			// Batches append straight to disk: a large table never has to fit in
			// memory, and a killed run loses at most the table it was reading.
			if err := checkpoint.AppendTable(ref, chunk.Table, chunk.Rows, chunk.Next == nil); err != nil {
				return DOManifest{}, err
			}
			if chunk.Next == nil {
				object.Rows[chunk.Table] = checkpoint.TableRows(ref, chunk.Table)
				closed[chunk.Table] = true
				progress.Tables++
			}
			rows += len(chunk.Rows)
		}

		progress.Rows += int64(rows)
		deps.logf(
			"chunk do=%s id=%s chunks=%d rows=%d done=%v ms=%d",
			ref.DO, ref.ID, len(result.Chunks), rows, result.Done, time.Since(started).Milliseconds(),
		)
		deps.report(*progress)

		if result.Done {
			// `done` is the server's claim; the checkpoint is the proof. A table
			// the server never sent would otherwise be silently missing.
			for _, table := range pending {
				if !closed[table.Name] {
					return DOManifest{}, invalidBackupf("table %s is missing from %s %s", table.Name, ref.DO, ref.ID)
				}
			}
			return object, nil
		}
		if sameBatchState(state, result.State) {
			return DOManifest{}, invalidBackupf("chunk cursor did not advance for %s %s", ref.DO, ref.ID)
		}
		state = result.State
	}
}

func sameBatchState(a, b BatchState) bool {
	if a.Index != b.Index {
		return false
	}
	if a.Cursor == nil || b.Cursor == nil {
		return a.Cursor == nil && b.Cursor == nil
	}
	return *a.Cursor == *b.Cursor
}

// exportObjects copies every artifact into the checkpoint. The listing is
// stored on the first run so a resumed run keeps the same entry numbers: an
// entry is named after the artifact's position in the listing.
func exportObjects(ctx context.Context, deps Deps, client *AdminClient, checkpoint *Checkpoint, progress *Progress, op string) (R2Manifest, error) {
	manifest := R2Manifest{Objects: []R2Item{}, Oversized: []string{}}
	state := checkpoint.State()

	if !state.R2.Listed {
		objects, err := client.ListObjects(ctx)
		if err != nil {
			return R2Manifest{}, err
		}
		listed := CheckpointR2{Listed: true}
		for index, object := range objects {
			if object.Size > MaxR2ObjectBytes {
				// The Worker cannot accept this object back, so keeping its bytes
				// would only produce a backup that cannot be restored. Record the
				// key so restore refuses the file with an explanation.
				listed.Oversized = append(listed.Oversized, object.Key)
				continue
			}
			entry, err := checkedObjectEntry(index + 1)
			if err != nil {
				return R2Manifest{}, err
			}
			listed.Objects = append(listed.Objects, R2Item{
				Key:         object.Key,
				Entry:       entry,
				Size:        object.Size,
				ContentType: object.ContentType,
			})
		}
		state.R2 = listed
		if err := checkpoint.Save(state); err != nil {
			return R2Manifest{}, err
		}
	}

	manifest.Oversized = append(manifest.Oversized, state.R2.Oversized...)
	progress.TotalObjects = len(state.R2.Objects) + len(state.R2.Oversized)
	deps.report(*progress)

	for _, item := range state.R2.Objects {
		if !checkpoint.HasObject(item.Entry) {
			started := time.Now()
			body, err := client.GetObject(ctx, item.Key)
			deps.logf("object key=%s size=%d ms=%d", item.Key, item.Size, time.Since(started).Milliseconds())
			if err != nil {
				return R2Manifest{}, err
			}
			err = checkpoint.WriteObject(item.Entry, body, item.Size)
			_ = body.Close()
			if err != nil {
				return R2Manifest{}, err
			}
			if item.Size > renewEveryBytes {
				if err := renewLease(ctx, client); err != nil {
					return R2Manifest{}, err
				}
			}
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
