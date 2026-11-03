package backup

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
)

const (
	acquirePath       = "/admin/maintenance/acquire"
	releasePath       = "/admin/maintenance/release"
	infoPath          = "/admin/backup/info"
	schemaPath        = "/admin/backup/schema"
	pagePath          = "/admin/backup/page"
	restoreBeginPath  = "/admin/restore/begin"
	restorePagePath   = "/admin/restore/page"
	restoreCommitPath = "/admin/restore/commit"
	restoreResetPath  = "/admin/restore/reset"
	objectListPath    = "/admin/r2/list"
	objectPath        = "/admin/r2/object"
)

// AdminClient calls the Worker's authenticated /admin/* routes. Every request
// carries the bearer token and the operation id, so the Worker can renew the
// maintenance lease that the export or restore holds.
type AdminClient struct {
	baseURL string
	token   string
	opID    string
	http    *http.Client
}

// DefaultAdminTimeout bounds one admin request, including streaming a large
// artifact. It is deliberately shorter than the 10-minute maintenance lease:
// a wedged request must fail and release the local busy guard before the
// lease could be re-acquired.
const DefaultAdminTimeout = 5 * time.Minute

// NewAdminClient builds a client for baseURL. A nil httpClient gets the
// finite default timeout; an injected client keeps its own policy and still
// honors the caller's context.
func NewAdminClient(baseURL, token, opID string, httpClient *http.Client) *AdminClient {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: DefaultAdminTimeout}
	}
	return &AdminClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		opID:    opID,
		http:    httpClient,
	}
}

// Info is the deployment identity reported by GET /admin/backup/info.
type Info struct {
	VersionID string   `json:"versionId"`
	TaskIDs   []string `json:"taskIds"`
	BotIDs    []string `json:"botIds"`
}

// ObjectInfo describes one artifact listed through the admin routes.
type ObjectInfo struct {
	Key         string `json:"key"`
	Size        int64  `json:"size"`
	ContentType string `json:"contentType"`
}

// Acquire takes or renews the maintenance lease for op.
func (c *AdminClient) Acquire(ctx context.Context, op string) error {
	payload := struct {
		Op   string `json:"op"`
		OpID string `json:"opId"`
	}{Op: op, OpID: c.opID}
	return c.call(ctx, http.MethodPost, acquirePath, nil, payload, nil)
}

// Release gives up the maintenance lease. The Worker deletes only the lease
// that matches this client's operation id, so a stale release is harmless.
func (c *AdminClient) Release(ctx context.Context) error {
	return c.call(ctx, http.MethodPost, releasePath, nil, nil, nil)
}

// Info reads the deployment's version id and its Task and Bot object ids.
func (c *AdminClient) Info(ctx context.Context) (Info, error) {
	var info Info
	if err := c.call(ctx, http.MethodGet, infoPath, nil, nil, &info); err != nil {
		return Info{}, err
	}
	return info, nil
}

// Schema reads one Durable Object's table and index definitions.
func (c *AdminClient) Schema(ctx context.Context, ref DORef) (DBSchema, error) {
	var schema DBSchema
	if err := c.call(ctx, http.MethodGet, schemaPath, doQuery(ref), nil, &schema); err != nil {
		return DBSchema{}, err
	}
	return schema, nil
}

// Page reads one page of a table. cursor is nil for the first page and next is
// nil on the last page.
func (c *AdminClient) Page(ctx context.Context, ref DORef, table TableSchema, cursor *string) ([]json.RawMessage, *string, error) {
	payload := struct {
		Table  TableSchema `json:"table"`
		Cursor *string     `json:"cursor"`
	}{Table: table, Cursor: cursor}
	var page struct {
		Rows []json.RawMessage `json:"rows"`
		Next *string           `json:"next"`
	}
	if err := c.call(ctx, http.MethodPost, pagePath, doQuery(ref), payload, &page); err != nil {
		return nil, nil, err
	}
	return page.Rows, page.Next, nil
}

// RestoreBegin empties one Durable Object and recreates its tables.
func (c *AdminClient) RestoreBegin(ctx context.Context, ref DORef, schema DBSchema) error {
	return c.call(ctx, http.MethodPost, restoreBeginPath, doQuery(ref), struct {
		Schema DBSchema `json:"schema"`
	}{Schema: schema}, nil)
}

// RestorePage writes one page of rows into one table.
func (c *AdminClient) RestorePage(ctx context.Context, ref DORef, table TableSchema, rows []json.RawMessage) error {
	return c.call(ctx, http.MethodPost, restorePagePath, doQuery(ref), struct {
		Table TableSchema       `json:"table"`
		Rows  []json.RawMessage `json:"rows"`
	}{Table: table, Rows: rows}, nil)
}

// RestoreCommit recreates the Durable Object's indexes and re-arms its alarm.
func (c *AdminClient) RestoreCommit(ctx context.Context, ref DORef, schema DBSchema) error {
	return c.call(ctx, http.MethodPost, restoreCommitPath, doQuery(ref), struct {
		Schema DBSchema `json:"schema"`
	}{Schema: schema}, nil)
}

// RestoreReset aborts the Durable Object's in-memory instance so the next
// request constructs one from the restored SQLite data.
func (c *AdminClient) RestoreReset(ctx context.Context, ref DORef) error {
	return c.call(ctx, http.MethodPost, restoreResetPath, doQuery(ref), nil, nil)
}

// ListObjects follows the list cursor until the Worker reports no more pages.
func (c *AdminClient) ListObjects(ctx context.Context) ([]ObjectInfo, error) {
	objects := []ObjectInfo{}
	cursor := ""
	seen := map[string]bool{}
	for {
		query := url.Values{}
		if cursor != "" {
			query.Set("cursor", cursor)
		}
		var page struct {
			Objects []ObjectInfo `json:"objects"`
			Next    *string      `json:"next"`
		}
		if err := c.call(ctx, http.MethodGet, objectListPath, query, nil, &page); err != nil {
			return nil, err
		}
		objects = append(objects, page.Objects...)
		if page.Next == nil || *page.Next == "" {
			return objects, nil
		}
		if seen[*page.Next] {
			return nil, domain.Error{
				Code:    CodeBackupInvalid,
				Message: fmt.Sprintf("artifact list cursor did not advance: %q", *page.Next),
			}
		}
		seen[*page.Next] = true
		cursor = *page.Next
	}
}

// GetObject streams one artifact. The caller closes the returned body.
func (c *AdminClient) GetObject(ctx context.Context, key string) (io.ReadCloser, error) {
	query := url.Values{"key": {key}}
	req, err := c.newRequest(ctx, http.MethodGet, objectPath, query, nil)
	if err != nil {
		return nil, err
	}
	response, err := c.send(req)
	if err != nil {
		return nil, err
	}
	// A 404 only reaches here after a lease-checked list succeeded, so the
	// artifact disappeared between listing and reading rather than the
	// deployment lacking admin support; report it as a damaged backup.
	if response.StatusCode == http.StatusNotFound {
		_ = response.Body.Close()
		return nil, domain.Error{
			Code:    CodeBackupInvalid,
			Message: fmt.Sprintf("artifact %q is missing", key),
		}
	}
	if err := c.checkResponse(response); err != nil {
		return nil, err
	}
	return response.Body, nil
}

// PutObject uploads one artifact with the size and content type the list
// reported, so the Worker can reject an object that exceeds its body limit.
func (c *AdminClient) PutObject(ctx context.Context, item ObjectInfo, body io.Reader) error {
	query := url.Values{"key": {item.Key}}
	// http.NoBody keeps a zero-length upload framed as Content-Length: 0;
	// net/http treats a non-nil body with ContentLength 0 as unknown length,
	// switches to chunked encoding, and the Worker answers 411 instead.
	requestBody := body
	if item.Size == 0 {
		requestBody = http.NoBody
	}
	req, err := c.newRequest(ctx, http.MethodPut, objectPath, query, requestBody)
	if err != nil {
		return err
	}
	req.ContentLength = item.Size
	if item.ContentType != "" {
		req.Header.Set("Content-Type", item.ContentType)
	}
	response, err := c.send(req)
	if err != nil {
		return err
	}
	if err := c.checkResponse(response); err != nil {
		return err
	}
	return drain(response)
}

// DeleteObject removes one artifact.
func (c *AdminClient) DeleteObject(ctx context.Context, key string) error {
	return c.call(ctx, http.MethodDelete, objectPath, url.Values{"key": {key}}, nil, nil)
}

func doQuery(ref DORef) url.Values {
	query := url.Values{}
	query.Set("do", ref.DO)
	if ref.ID != "" {
		query.Set("id", ref.ID)
	}
	return query
}

func (c *AdminClient) call(ctx context.Context, method, path string, query url.Values, payload, out any) error {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("backup: encode %s request: %w", path, err)
		}
		body = bytes.NewReader(encoded)
	}
	req, err := c.newRequest(ctx, method, path, query, body)
	if err != nil {
		return err
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := c.send(req)
	if err != nil {
		return err
	}
	if err := c.checkResponse(response); err != nil {
		return err
	}
	if out == nil {
		return drain(response)
	}
	defer response.Body.Close()
	if err := json.NewDecoder(response.Body).Decode(out); err != nil {
		return domain.Error{
			Code:    CodeBackupInvalid,
			Message: fmt.Sprintf("decode %s response: %v", path, err),
		}
	}
	return nil
}

func (c *AdminClient) newRequest(ctx context.Context, method, path string, query url.Values, body io.Reader) (*http.Request, error) {
	target := c.baseURL + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return nil, fmt.Errorf("backup: build admin request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("X-Backup-Op", c.opID)
	return req, nil
}

func (c *AdminClient) send(req *http.Request) (*http.Response, error) {
	response, err := c.http.Do(req)
	if err != nil {
		if ctxErr := req.Context().Err(); ctxErr != nil {
			return nil, ctxErr
		}
		return nil, fmt.Errorf("backup: admin request: %s", c.redact(err.Error()))
	}
	return response, nil
}

// checkResponse returns nil for a success and otherwise consumes the body into
// a coded error.
func (c *AdminClient) checkResponse(response *http.Response) error {
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return nil
	}
	return c.statusError(response)
}

func (c *AdminClient) statusError(response *http.Response) error {
	defer response.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 8<<10))
	var payload struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(raw, &payload)

	code := payload.Code
	if code == "" {
		switch response.StatusCode {
		case http.StatusUnauthorized:
			code = CodeAdminUnauthorized
		case http.StatusNotFound:
			code = CodeAdminUnavailable
		case http.StatusConflict:
			code = CodeMaintenanceRequired
		case http.StatusRequestEntityTooLarge:
			code = CodeBackupObjectTooLarge
		default:
			code = CodeBackupInvalid
		}
	}
	message := payload.Message
	if message == "" {
		message = fmt.Sprintf("admin request returned HTTP %d", response.StatusCode)
	}
	return domain.Error{Code: code, Message: c.redact(message)}
}

// redact keeps the token out of an error surfaced to the user or a log.
func (c *AdminClient) redact(text string) string {
	if c.token == "" || !strings.Contains(text, c.token) {
		return text
	}
	return strings.ReplaceAll(text, c.token, domain.RedactedValue)
}

func drain(response *http.Response) error {
	defer response.Body.Close()
	_, err := io.Copy(io.Discard, response.Body)
	return err
}
