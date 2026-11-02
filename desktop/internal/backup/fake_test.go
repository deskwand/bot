package backup

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"sync"
	"testing"
	"time"
)

// fakeDO is one in-memory Durable Object: its schema plus the rows currently
// stored in each table.
type fakeDO struct {
	schema DBSchema
	rows   map[string][]json.RawMessage
	resets int
}

// fakeObject is one artifact. A non-zero size overrides the body length, which
// lets a test describe an object larger than the Worker accepts without
// allocating its bytes.
type fakeObject struct {
	body        []byte
	contentType string
	size        int64
}

// fakeFailure makes the nth call of a route answer with status. A zero or
// negative nth matches every call, and an empty method, path, do or id is a
// wildcard.
type fakeFailure struct {
	method string
	path   string
	do     string
	id     string
	nth    int
	status int
	calls  int
}

// fakeRequest is one recorded admin request.
type fakeRequest struct {
	Method  string
	Path    string
	Query   url.Values
	Headers http.Header
	DO      string
	ID      string
	OpID    string
}

func (r fakeRequest) String() string {
	if r.DO == "" {
		return r.Method + " " + r.Path
	}
	if r.ID == "" {
		return fmt.Sprintf("%s %s do=%s", r.Method, r.Path, r.DO)
	}
	return fmt.Sprintf("%s %s do=%s id=%s", r.Method, r.Path, r.DO, r.ID)
}

// fakeWorker is an in-memory stand-in for the Worker's /admin/* routes. It
// follows the real gateway and R2 routes closely enough for the Go export and
// restore flows: bearer auth, the maintenance lease, DO schema/page/restore
// RPCs and artifact uploads that require Content-Length.
type fakeWorker struct {
	server *httptest.Server

	token     string
	versionID string
	taskIDs   []string

	dos     map[string]*fakeDO
	objects map[string]*fakeObject

	// pageRows and listRows cap one DO page and one R2 list page; zero uses
	// the default of 2.
	pageRows int
	listRows int

	requests []fakeRequest
	failures []*fakeFailure

	leaseOp   string
	leaseOpID string

	mu sync.Mutex
}

func newFakeWorker(t *testing.T) *fakeWorker {
	t.Helper()
	worker := &fakeWorker{
		dos:      map[string]*fakeDO{},
		objects:  map[string]*fakeObject{},
		pageRows: 2,
		listRows: 2,
	}
	worker.server = httptest.NewServer(http.HandlerFunc(worker.serveHTTP))
	t.Cleanup(worker.server.Close)
	return worker
}

func (f *fakeWorker) URL() string { return f.server.URL }

func doKey(ref DORef) string {
	if ref.ID == "" {
		return ref.DO
	}
	return ref.DO + "/" + ref.ID
}

// setDO stores one Durable Object's schema and table rows.
func (f *fakeWorker) setDO(ref DORef, schema DBSchema, rows map[string][]json.RawMessage) {
	f.mu.Lock()
	defer f.mu.Unlock()
	object := &fakeDO{schema: schema, rows: map[string][]json.RawMessage{}}
	for name, tableRows := range rows {
		object.rows[name] = append([]json.RawMessage(nil), tableRows...)
	}
	f.dos[doKey(ref)] = object
}

// addObject stores one artifact. The list route reports the body length.
func (f *fakeWorker) addObject(key, contentType string, body []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.objects[key] = &fakeObject{body: append([]byte(nil), body...), contentType: contentType}
}

// addOversizedObject lists an artifact with size bytes while serving only body.
func (f *fakeWorker) addOversizedObject(key, contentType string, size int64, body []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.objects[key] = &fakeObject{
		body:        append([]byte(nil), body...),
		contentType: contentType,
		size:        size,
	}
}

// failRoute registers a status for the nth call (1-based) of a route. Call it
// repeatedly for several calls; nth <= 0 fails every call.
func (f *fakeWorker) failRoute(method, path, do, id string, nth, status int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failures = append(f.failures, &fakeFailure{
		method: method,
		path:   path,
		do:     do,
		id:     id,
		nth:    nth,
		status: status,
	})
}

// failAll makes every admin request answer with status.
func (f *fakeWorker) failAll(status int) {
	f.failRoute("", "", "", "", 0, status)
}

func (f *fakeWorker) serveHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	query := r.URL.Query()
	record := fakeRequest{
		Method:  r.Method,
		Path:    r.URL.Path,
		Query:   query,
		Headers: r.Header.Clone(),
		DO:      query.Get("do"),
		ID:      query.Get("id"),
		OpID:    r.Header.Get("X-Backup-Op"),
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, record)

	if f.token != "" && r.Header.Get("Authorization") != "Bearer "+f.token {
		f.writeJSON(w, http.StatusUnauthorized, map[string]string{"code": "ADMIN_UNAUTHORIZED"})
		return
	}
	if status := f.injectedStatus(record); status != 0 {
		// Inject the status alone so the client maps it by HTTP status, as it
		// would for a proxy error with no JSON body.
		w.WriteHeader(status)
		return
	}

	switch {
	case r.Method == http.MethodPost && record.Path == acquirePath:
		f.acquire(w, body)
		return
	case r.Method == http.MethodPost && record.Path == releasePath:
		if record.OpID != "" && record.OpID == f.leaseOpID {
			f.leaseOpID = ""
			f.leaseOp = ""
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	switch record.Path {
	case infoPath, schemaPath, pagePath, restoreBeginPath, restorePagePath, restoreCommitPath, restoreResetPath, objectListPath, objectPath:
	default:
		// Unknown paths answer 404 before the lease check, like the real gateway.
		http.NotFound(w, r)
		return
	}

	if record.OpID == "" || record.OpID != f.leaseOpID {
		f.writeJSON(w, http.StatusConflict, map[string]string{"code": "MAINTENANCE_REQUIRED"})
		return
	}

	switch record.Path {
	case schemaPath, pagePath, restoreBeginPath, restorePagePath, restoreCommitPath, restoreResetPath:
		if !validDOKind(record.DO) {
			f.writeJSON(w, http.StatusBadRequest, map[string]string{"code": "BACKUP_INVALID"})
			return
		}
	}

	switch record.Path {
	case infoPath:
		taskIDs := f.taskIDs
		if taskIDs == nil {
			taskIDs = []string{}
		}
		f.writeJSON(w, http.StatusOK, map[string]any{
			"versionId": f.versionID,
			"taskIds":   taskIDs,
		})
	case schemaPath:
		f.writeJSON(w, http.StatusOK, f.doFor(record).schema)
	case pagePath:
		var payload struct {
			Table  TableSchema `json:"table"`
			Cursor *string     `json:"cursor"`
		}
		if !decodeFakeBody(w, body, &payload) {
			return
		}
		object := f.doFor(record)
		rows := object.rows[payload.Table.Name]
		cursor := ""
		if payload.Cursor != nil {
			cursor = *payload.Cursor
		}
		offset, ok := fakeOffset(w, cursor, len(rows))
		if !ok {
			return
		}
		end := offset + f.pageLimit()
		if end > len(rows) {
			end = len(rows)
		}
		var next any
		if end < len(rows) {
			next = strconv.Itoa(end)
		}
		page := append([]json.RawMessage(nil), rows[offset:end]...)
		f.writeJSON(w, http.StatusOK, map[string]any{"rows": page, "next": next})
	case restoreBeginPath:
		var payload struct {
			Schema DBSchema `json:"schema"`
		}
		if !decodeFakeBody(w, body, &payload) {
			return
		}
		object := f.doFor(record)
		object.schema = payload.Schema
		object.rows = map[string][]json.RawMessage{}
		for _, table := range payload.Schema.Tables {
			object.rows[table.Name] = []json.RawMessage{}
		}
		w.WriteHeader(http.StatusNoContent)
	case restorePagePath:
		var payload struct {
			Table TableSchema       `json:"table"`
			Rows  []json.RawMessage `json:"rows"`
		}
		if !decodeFakeBody(w, body, &payload) {
			return
		}
		object := f.doFor(record)
		object.rows[payload.Table.Name] = append(object.rows[payload.Table.Name], payload.Rows...)
		w.WriteHeader(http.StatusNoContent)
	case restoreCommitPath:
		var payload struct {
			Schema DBSchema `json:"schema"`
		}
		if !decodeFakeBody(w, body, &payload) {
			return
		}
		f.doFor(record).schema = payload.Schema
		w.WriteHeader(http.StatusNoContent)
	case restoreResetPath:
		f.doFor(record).resets++
		w.WriteHeader(http.StatusNoContent)
	case objectListPath:
		f.listObjects(w, record)
	case objectPath:
		f.objectRoute(w, record, body)
	default:
		http.NotFound(w, r)
	}
}

func (f *fakeWorker) acquire(w http.ResponseWriter, body []byte) {
	var payload struct {
		Op   string `json:"op"`
		OpID string `json:"opId"`
	}
	if !decodeFakeBody(w, body, &payload) {
		return
	}
	if payload.OpID == "" {
		f.writeJSON(w, http.StatusBadRequest, map[string]string{"code": "BACKUP_INVALID"})
		return
	}
	if f.leaseOpID != "" && f.leaseOpID != payload.OpID {
		f.writeJSON(w, http.StatusConflict, map[string]string{"code": "MAINTENANCE_BUSY"})
		return
	}
	f.leaseOpID = payload.OpID
	f.leaseOp = payload.Op
	f.writeJSON(w, http.StatusOK, map[string]any{
		"until": time.Now().Add(10 * time.Minute).UnixMilli(),
	})
}

func (f *fakeWorker) listObjects(w http.ResponseWriter, record fakeRequest) {
	keys := make([]string, 0, len(f.objects))
	for key := range f.objects {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	cursor := record.Query.Get("cursor")
	offset, ok := fakeOffset(w, cursor, len(keys))
	if !ok {
		return
	}
	end := offset + f.listLimit()
	if end > len(keys) {
		end = len(keys)
	}
	var next any
	if end < len(keys) {
		next = strconv.Itoa(end)
	}
	objects := make([]map[string]any, 0, end-offset)
	for _, key := range keys[offset:end] {
		object := f.objects[key]
		objects = append(objects, map[string]any{
			"key":         key,
			"size":        object.reportedSize(),
			"contentType": object.contentType,
		})
	}
	f.writeJSON(w, http.StatusOK, map[string]any{"objects": objects, "next": next})
}

func (f *fakeWorker) objectRoute(w http.ResponseWriter, record fakeRequest, body []byte) {
	key := record.Query.Get("key")
	if key == "" {
		f.writeJSON(w, http.StatusBadRequest, map[string]string{"code": "BACKUP_INVALID"})
		return
	}
	switch record.Method {
	case http.MethodGet:
		object, ok := f.objects[key]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		contentType := object.contentType
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		w.Header().Set("content-type", contentType)
		w.Header().Set("content-length", strconv.Itoa(len(object.body)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(object.body)
	case http.MethodPut:
		// The real route requires Content-Length before it reads the body.
		length, err := strconv.ParseInt(record.Headers.Get("content-length"), 10, 64)
		if err != nil || length < 0 {
			f.writeJSON(w, http.StatusLengthRequired, map[string]string{"code": "BACKUP_INVALID"})
			return
		}
		if length > MaxR2ObjectBytes {
			f.writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"code": "BACKUP_OBJECT_TOO_LARGE"})
			return
		}
		f.objects[key] = &fakeObject{
			body:        append([]byte(nil), body...),
			contentType: fakeContentType(record.Headers.Get("content-type")),
		}
		w.WriteHeader(http.StatusNoContent)
	case http.MethodDelete:
		delete(f.objects, key)
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (f *fakeWorker) doFor(record fakeRequest) *fakeDO {
	key := record.DO
	if record.ID != "" {
		key += "/" + record.ID
	}
	object, ok := f.dos[key]
	if !ok {
		object = &fakeDO{schema: DBSchema{}, rows: map[string][]json.RawMessage{}}
		f.dos[key] = object
	}
	return object
}

func (f *fakeWorker) injectedStatus(record fakeRequest) int {
	status := 0
	for _, failure := range f.failures {
		if failure.method != "" && failure.method != record.Method {
			continue
		}
		if failure.path != "" && failure.path != record.Path {
			continue
		}
		if failure.do != "" && failure.do != record.DO {
			continue
		}
		if failure.id != "" && failure.id != record.ID {
			continue
		}
		// Every matching rule counts this call, so rules for later calls keep
		// their position even when an earlier rule answers first.
		failure.calls++
		if status == 0 && (failure.nth <= 0 || failure.calls == failure.nth) {
			status = failure.status
		}
	}
	return status
}

func (f *fakeWorker) writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func decodeFakeBody(w http.ResponseWriter, body []byte, out any) bool {
	if err := json.Unmarshal(body, out); err != nil {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"code":"BACKUP_INVALID"}`)
		return false
	}
	return true
}

func (o *fakeObject) reportedSize() int64 {
	if o.size > 0 {
		return o.size
	}
	return int64(len(o.body))
}

func (f *fakeWorker) pageLimit() int {
	if f.pageRows > 0 {
		return f.pageRows
	}
	return 2
}

func (f *fakeWorker) listLimit() int {
	if f.listRows > 0 {
		return f.listRows
	}
	return 2
}

// fakeOffset decodes an index cursor and rejects one past the end.
func fakeOffset(w http.ResponseWriter, cursor string, length int) (int, bool) {
	if cursor == "" {
		return 0, true
	}
	offset, err := strconv.Atoi(cursor)
	if err != nil || offset < 0 || offset > length {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"code":"BACKUP_INVALID"}`)
		return 0, false
	}
	return offset, true
}

func validDOKind(kind string) bool {
	switch kind {
	case "butler", "task", "channel":
		return true
	default:
		return false
	}
}

func fakeContentType(value string) string {
	if value == "" {
		return "application/octet-stream"
	}
	return value
}

// requests returns a copy of the recorded requests.
func (f *fakeWorker) requestsLog() []fakeRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fakeRequest(nil), f.requests...)
}

// requestCount counts recorded requests with the given method and path.
func (f *fakeWorker) requestCount(method, path string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	count := 0
	for _, request := range f.requests {
		if request.Method == method && request.Path == path {
			count++
		}
	}
	return count
}

// hasLease reports whether a lease is currently held.
func (f *fakeWorker) hasLease() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.leaseOpID != ""
}

// lease returns the current lease's operation and id.
func (f *fakeWorker) lease() (op, opID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.leaseOp, f.leaseOpID
}

// expireLease removes the lease as if its 10-minute window elapsed. A strict
// renewal must fail afterwards instead of silently acquiring a new lease.
func (f *fakeWorker) expireLease() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.leaseOp = ""
	f.leaseOpID = ""
}

// rowsOf returns a copy of one Durable Object's table rows.
func (f *fakeWorker) rowsOf(ref DORef) map[string][]json.RawMessage {
	f.mu.Lock()
	defer f.mu.Unlock()
	object, ok := f.dos[doKey(ref)]
	if !ok {
		return map[string][]json.RawMessage{}
	}
	rows := make(map[string][]json.RawMessage, len(object.rows))
	for name, tableRows := range object.rows {
		rows[name] = append([]json.RawMessage(nil), tableRows...)
	}
	return rows
}

// schemaOf returns one Durable Object's current schema.
func (f *fakeWorker) schemaOf(ref DORef) DBSchema {
	f.mu.Lock()
	defer f.mu.Unlock()
	object, ok := f.dos[doKey(ref)]
	if !ok {
		return DBSchema{}
	}
	return object.schema
}

// resetsOf reports how many restoreReset calls one Durable Object received.
func (f *fakeWorker) resetsOf(ref DORef) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	object, ok := f.dos[doKey(ref)]
	if !ok {
		return 0
	}
	return object.resets
}

// objectKeys lists the stored artifact keys.
func (f *fakeWorker) objectKeys() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	keys := make([]string, 0, len(f.objects))
	for key := range f.objects {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// object returns one artifact's bytes and content type.
func (f *fakeWorker) object(key string) ([]byte, string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	object, ok := f.objects[key]
	if !ok {
		return nil, "", false
	}
	return append([]byte(nil), object.body...), object.contentType, true
}

// sequence renders the recorded requests for order assertions.
func (f *fakeWorker) sequence() []string {
	requests := f.requestsLog()
	rendered := make([]string, 0, len(requests))
	for _, request := range requests {
		rendered = append(rendered, request.String())
	}
	return rendered
}
