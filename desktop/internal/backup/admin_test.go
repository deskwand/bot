package backup

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
)

func adminErrorCode(t *testing.T, err error) string {
	t.Helper()
	if err == nil {
		t.Fatal("expected an error")
	}
	var coded domain.Error
	if !errors.As(err, &coded) {
		t.Fatalf("error %v is not a domain error", err)
	}
	return coded.Code
}

func TestAdminClientSendsBearerAndOpHeader(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/admin/backup/info" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer tok" {
			t.Errorf("Authorization = %q", got)
		}
		if got := r.Header.Get("X-Backup-Op"); got != "op-1" {
			t.Errorf("X-Backup-Op = %q", got)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"versionId": "version-1",
			"taskIds":   []string{"task-a", "task-b"},
		})
	}))
	defer server.Close()

	client := NewAdminClient(server.URL, "tok", "op-1", server.Client())
	info, err := client.Info(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if info.VersionID != "version-1" || len(info.TaskIDs) != 2 || info.TaskIDs[1] != "task-b" {
		t.Fatalf("info = %+v", info)
	}
}

func TestInfoWithoutBotIDs(t *testing.T) {
	// An older Worker does not return botIds; the client must still parse it.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"versionId": "version-1",
			"taskIds":   []string{"task-a"},
		})
	}))
	defer server.Close()

	client := NewAdminClient(server.URL, "tok", "op-1", server.Client())
	info, err := client.Info(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if info.BotIDs != nil {
		t.Fatalf("bot ids = %v, want nil", info.BotIDs)
	}
}

func TestAdminClientMapsStatusCodes(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		want   string
	}{
		{"unauthorized", http.StatusUnauthorized, `{"code":"ADMIN_UNAUTHORIZED"}`, CodeAdminUnauthorized},
		{"unavailable", http.StatusNotFound, `Not found`, CodeAdminUnavailable},
		{"busy", http.StatusConflict, `{"code":"MAINTENANCE_BUSY"}`, CodeMaintenanceBusy},
		{"required", http.StatusConflict, `{"code":"MAINTENANCE_REQUIRED"}`, CodeMaintenanceRequired},
		{"conflict_without_code", http.StatusConflict, `{"message":"try later"}`, CodeMaintenanceRequired},
		{"too_large", http.StatusRequestEntityTooLarge, `{"code":"BACKUP_OBJECT_TOO_LARGE"}`, CodeBackupObjectTooLarge},
		{"server_error", http.StatusInternalServerError, `{"code":"BACKUP_INVALID","message":"backup request failed"}`, CodeBackupInvalid},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(testCase.status)
				_, _ = w.Write([]byte(testCase.body))
			}))
			defer server.Close()

			client := NewAdminClient(server.URL, "tok", "op-1", server.Client())
			_, err := client.Info(context.Background())
			if code := adminErrorCode(t, err); code != testCase.want {
				t.Fatalf("code = %q, want %q", code, testCase.want)
			}
		})
	}
}

func TestAdminClientResetTreatsNoContentAsSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/admin/restore/reset" {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		if got := r.URL.Query().Get("do"); got != "task" {
			t.Errorf("do = %q", got)
		}
		if got := r.URL.Query().Get("id"); got != "task-a" {
			t.Errorf("id = %q", got)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := NewAdminClient(server.URL, "tok", "op-1", server.Client())
	if err := client.RestoreReset(context.Background(), DORef{DO: "task", ID: "task-a"}); err != nil {
		t.Fatal(err)
	}
}

func TestAdminClientRedactsTokenInServerMessage(t *testing.T) {
	const token = "secret-token-value"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"MAINTENANCE_BUSY","message":"lease held by ` + token + `"}`))
	}))
	defer server.Close()

	client := NewAdminClient(server.URL, token, "op-1", server.Client())
	_, err := client.Info(context.Background())
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), token) {
		t.Fatalf("error leaked the token: %v", err)
	}
	if !strings.Contains(err.Error(), domain.RedactedValue) {
		t.Fatalf("error does not mention the redaction marker: %v", err)
	}
}

func TestAdminClientSendsWireFormat(t *testing.T) {
	table := TableSchema{
		Name:         "notes",
		Create:       `CREATE TABLE "notes" (id INTEGER PRIMARY KEY, body TEXT)`,
		WithoutRowid: false,
	}
	schema := DBSchema{
		Tables:  []TableSchema{table},
		Indexes: []string{`CREATE INDEX "notes_body" ON "notes" (body)`},
	}
	var (
		acquireBody []byte
		pageBody    []byte
		pageQuery   url.Values
		beginBody   []byte
		commitBody  []byte
		pageRestore []byte
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read %s body: %v", r.URL.Path, err)
		}
		switch r.URL.Path {
		case "/admin/maintenance/acquire":
			acquireBody = body
			_, _ = w.Write([]byte(`{"until":1700000000000}`))
		case "/admin/backup/page":
			pageBody = body
			pageQuery = r.URL.Query()
			_, _ = w.Write([]byte(`{"rows":[{"id":1}],"next":null}`))
		case "/admin/restore/begin":
			beginBody = body
			w.WriteHeader(http.StatusNoContent)
		case "/admin/restore/commit":
			commitBody = body
			w.WriteHeader(http.StatusNoContent)
		case "/admin/restore/page":
			pageRestore = body
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	client := NewAdminClient(server.URL, "tok", "op-1", server.Client())
	ctx := context.Background()
	ref := DORef{DO: "task", ID: "task-1"}

	if err := client.Acquire(ctx, "export"); err != nil {
		t.Fatal(err)
	}
	if got, want := string(acquireBody), `{"op":"export","opId":"op-1"}`; got != want {
		t.Fatalf("acquire body = %s, want %s", got, want)
	}

	rows, next, err := client.Page(ctx, ref, table, nil)
	if err != nil {
		t.Fatal(err)
	}
	if next != nil || len(rows) != 1 || string(rows[0]) != `{"id":1}` {
		t.Fatalf("page = %s, next = %v", rows, next)
	}
	if got := pageQuery.Get("do"); got != "task" {
		t.Fatalf("page do = %q", got)
	}
	if got := pageQuery.Get("id"); got != "task-1" {
		t.Fatalf("page id = %q", got)
	}
	var pageObject map[string]json.RawMessage
	if err := json.Unmarshal(pageBody, &pageObject); err != nil {
		t.Fatal(err)
	}
	if len(pageObject) != 2 {
		t.Fatalf("page body keys = %v", pageObject)
	}
	if got := string(pageObject["cursor"]); got != "null" {
		t.Fatalf("page cursor = %s", got)
	}
	var pageTable TableSchema
	if err := json.Unmarshal(pageObject["table"], &pageTable); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(pageTable, table) {
		t.Fatalf("page table = %+v", pageTable)
	}

	if err := client.RestoreBegin(ctx, ref, schema); err != nil {
		t.Fatal(err)
	}
	wantSchema, err := json.Marshal(struct {
		Schema DBSchema `json:"schema"`
	}{Schema: schema})
	if err != nil {
		t.Fatal(err)
	}
	if string(beginBody) != string(wantSchema) {
		t.Fatalf("begin body = %s, want %s", beginBody, wantSchema)
	}

	restoreRows := []json.RawMessage{json.RawMessage(`{"id":1}`)}
	if err := client.RestorePage(ctx, ref, table, restoreRows); err != nil {
		t.Fatal(err)
	}
	var pagePayload struct {
		Table TableSchema       `json:"table"`
		Rows  []json.RawMessage `json:"rows"`
	}
	if err := json.Unmarshal(pageRestore, &pagePayload); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(pagePayload.Table, table) || len(pagePayload.Rows) != 1 || string(pagePayload.Rows[0]) != `{"id":1}` {
		t.Fatalf("restore page = %s", pageRestore)
	}

	if err := client.RestoreCommit(ctx, ref, schema); err != nil {
		t.Fatal(err)
	}
	if string(commitBody) != string(wantSchema) {
		t.Fatalf("commit body = %s, want %s", commitBody, wantSchema)
	}
}

func TestAdminClientObjectsRoundTrip(t *testing.T) {
	type upload struct {
		key         string
		contentType string
		length      int64
		transfer    []string
		body        []byte
	}
	var uploads []upload
	var deleted string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/admin/r2/list" && r.Method == http.MethodGet:
			w.Header().Set("content-type", "application/json")
			if r.URL.Query().Get("cursor") == "" {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"objects": []ObjectInfo{{Key: "a/b c?.png", Size: 5, ContentType: "image/png"}},
					"next":    "page-2",
				})
				return
			}
			if got := r.URL.Query().Get("cursor"); got != "page-2" {
				t.Errorf("cursor = %q", got)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"objects": []ObjectInfo{{Key: "notes.txt", Size: 2, ContentType: "text/plain"}},
				"next":    nil,
			})
		case r.URL.Path == "/admin/r2/object" && r.Method == http.MethodPut:
			body, err := io.ReadAll(r.Body)
			if err != nil {
				t.Errorf("read body: %v", err)
			}
			uploads = append(uploads, upload{
				key:         r.URL.Query().Get("key"),
				contentType: r.Header.Get("content-type"),
				length:      r.ContentLength,
				transfer:    append([]string(nil), r.TransferEncoding...),
				body:        body,
			})
			w.WriteHeader(http.StatusNoContent)
		case r.URL.Path == "/admin/r2/object" && r.Method == http.MethodGet:
			if got := r.URL.Query().Get("key"); got != "a/b c?.png" {
				t.Errorf("key = %q", got)
			}
			w.Header().Set("content-type", "image/png")
			_, _ = w.Write([]byte("hello"))
		case r.URL.Path == "/admin/r2/object" && r.Method == http.MethodDelete:
			deleted = r.URL.Query().Get("key")
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	client := NewAdminClient(server.URL, "tok", "op-1", server.Client())
	ctx := context.Background()

	objects, err := client.ListObjects(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(objects) != 2 || objects[0].Key != "a/b c?.png" || objects[1].Key != "notes.txt" {
		t.Fatalf("objects = %+v", objects)
	}
	if objects[0].ContentType != "image/png" || objects[0].Size != 5 {
		t.Fatalf("first object = %+v", objects[0])
	}

	body, err := client.GetObject(ctx, "a/b c?.png")
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(body)
	if err != nil {
		t.Fatal(err)
	}
	if err := body.Close(); err != nil {
		t.Fatal(err)
	}
	if string(data) != "hello" {
		t.Fatalf("object body = %q", data)
	}

	item := ObjectInfo{Key: "a/b c?.png", Size: 5, ContentType: "image/png"}
	if err := client.PutObject(ctx, item, io.MultiReader(bytes.NewReader([]byte("hello")))); err != nil {
		t.Fatal(err)
	}
	empty := ObjectInfo{Key: "empty.bin", Size: 0, ContentType: "application/octet-stream"}
	if err := client.PutObject(ctx, empty, io.MultiReader(bytes.NewReader(nil))); err != nil {
		t.Fatal(err)
	}

	if len(uploads) != 2 {
		t.Fatalf("uploads = %+v", uploads)
	}
	first, second := uploads[0], uploads[1]
	if first.key != item.Key {
		t.Fatalf("put key = %q", first.key)
	}
	if first.contentType != "image/png" {
		t.Fatalf("put content type = %q", first.contentType)
	}
	if first.length != 5 {
		t.Fatalf("put content length = %d", first.length)
	}
	if len(first.transfer) != 0 {
		t.Fatalf("put used transfer encoding %v", first.transfer)
	}
	if string(first.body) != "hello" {
		t.Fatalf("put body = %q", first.body)
	}
	if second.key != empty.Key {
		t.Fatalf("empty put key = %q", second.key)
	}
	if second.length != 0 {
		t.Fatalf("empty put content length = %d", second.length)
	}
	if len(second.transfer) != 0 {
		t.Fatalf("empty put used transfer encoding %v", second.transfer)
	}
	if len(second.body) != 0 {
		t.Fatalf("empty put body = %q", second.body)
	}

	if err := client.DeleteObject(ctx, item.Key); err != nil {
		t.Fatal(err)
	}
	if deleted != item.Key {
		t.Fatalf("deleted = %q", deleted)
	}
}

func TestAdminClientDefaultTimeoutIsFinite(t *testing.T) {
	client := NewAdminClient("https://example.com", "tok", "op-1", nil)
	if client.http.Timeout != DefaultAdminTimeout {
		t.Fatalf("timeout = %v, want %v", client.http.Timeout, DefaultAdminTimeout)
	}
	if client.http.Timeout >= 10*time.Minute {
		t.Fatalf("timeout %v is not shorter than the lease", client.http.Timeout)
	}
}

func TestAdminClientStalledServerTimesOut(t *testing.T) {
	started := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started <- struct{}{}
		<-r.Context().Done()
	}))
	defer server.Close()

	client := NewAdminClient(server.URL, "tok", "op-1", &http.Client{Timeout: 50 * time.Millisecond})
	begin := time.Now()
	_, err := client.Info(context.Background())
	if err == nil {
		t.Fatal("expected the stalled request to fail")
	}
	if elapsed := time.Since(begin); elapsed > time.Second {
		t.Fatalf("stalled request took %v, want a bounded failure", elapsed)
	}
	select {
	case <-started:
	default:
		t.Fatal("server request never started")
	}
}

func TestAdminClientCancellationStopsLargeTransfer(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/octet-stream")
		w.WriteHeader(http.StatusOK)
		chunk := bytes.Repeat([]byte("x"), 64<<10)
		flusher, _ := w.(http.Flusher)
		for i := 0; i < 1000; i++ {
			select {
			case <-r.Context().Done():
				return
			default:
			}
			if _, err := w.Write(chunk); err != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
			time.Sleep(5 * time.Millisecond)
		}
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	client := NewAdminClient(server.URL, "tok", "op-1", server.Client())
	body, err := client.GetObject(ctx, "big.bin")
	if err != nil {
		t.Fatal(err)
	}
	first := make([]byte, 1024)
	if _, err := io.ReadFull(body, first); err != nil {
		_ = body.Close()
		t.Fatal(err)
	}
	cancel()
	_, readErr := io.Copy(io.Discard, body)
	_ = body.Close()
	if readErr == nil {
		t.Fatal("cancelled transfer kept reading to completion")
	}
}

func TestListObjectsRejectsRepeatedCursor(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"objects": []ObjectInfo{{Key: "a.png", Size: 1}},
			"next":    "stuck",
		})
	}))
	defer server.Close()

	client := NewAdminClient(server.URL, "tok", "op-1", server.Client())
	_, err := client.ListObjects(context.Background())
	if code := adminErrorCode(t, err); code != CodeBackupInvalid {
		t.Fatalf("code = %q, want %q", code, CodeBackupInvalid)
	}
}
