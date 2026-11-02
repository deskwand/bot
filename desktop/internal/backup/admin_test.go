package backup

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

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

func TestAdminClientObjectsRoundTrip(t *testing.T) {
	var (
		putKey    string
		putType   string
		putLength int64
		putBody   []byte
		deleted   string
	)
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
			putKey = r.URL.Query().Get("key")
			putType = r.Header.Get("content-type")
			putLength = r.ContentLength
			var err error
			putBody, err = io.ReadAll(r.Body)
			if err != nil {
				t.Errorf("read body: %v", err)
			}
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
	if err := client.PutObject(ctx, item, bytes.NewReader([]byte("hello"))); err != nil {
		t.Fatal(err)
	}
	if putKey != item.Key {
		t.Fatalf("put key = %q", putKey)
	}
	if putType != "image/png" {
		t.Fatalf("put content type = %q", putType)
	}
	if putLength != 5 {
		t.Fatalf("put content length = %d", putLength)
	}
	if string(putBody) != "hello" {
		t.Fatalf("put body = %q", putBody)
	}

	if err := client.DeleteObject(ctx, item.Key); err != nil {
		t.Fatal(err)
	}
	if deleted != item.Key {
		t.Fatalf("deleted = %q", deleted)
	}
}
