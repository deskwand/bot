package wechat

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"
)

const (
	pollInterval = 2 * time.Second
	maxQRRefresh = 3
)

// Login state values shown to the user. They never contain a token.
const (
	LoginWaiting   = "wait"
	LoginScanned   = "scaned"
	LoginConfirmed = "confirmed"
	LoginExpired   = "expired"
	LoginCancelled = "cancelled"
)

// ErrQRExpired is returned after three QR codes have expired.
var ErrQRExpired = errors.New("wechat: QR code expired, please sign in again")

// RedactedToken replaces the token in every textual representation of
// Credentials. SecretJSON is the only way to obtain the publishable value.
const RedactedToken = "<redacted>"

// LoginStatus is the only login state the UI receives. It deliberately has no
// credential or raw response field.
type LoginStatus struct {
	OperationID string
	State       string
	// Phase names the step within State so the app can localize the text.
	Phase     string
	QRContent string
	Message   string
}

// Credentials is the value stored in the WECHAT_CREDENTIALS secret. The JSON
// field names match the existing TypeScript implementation.
type Credentials struct {
	Token     string `json:"token"`
	BaseURL   string `json:"baseUrl"`
	AccountID string `json:"accountId"`
	UserID    string `json:"userId"`
}

// secretCredentials avoids Credentials.MarshalJSON so the token can be
// serialized for publication.
type secretCredentials struct {
	Token     string `json:"token"`
	BaseURL   string `json:"baseUrl"`
	AccountID string `json:"accountId"`
	UserID    string `json:"userId"`
}

// SecretJSON returns the exact JSON value for WECHAT_CREDENTIALS. Callers must
// send it directly to the publisher and must never log it.
func (c Credentials) SecretJSON() ([]byte, error) {
	return json.Marshal(secretCredentials{
		Token:     c.Token,
		BaseURL:   c.BaseURL,
		AccountID: c.AccountID,
		UserID:    c.UserID,
	})
}

// MarshalJSON always redacts the token, so logging a Credentials value through
// a generic JSON path cannot expose it.
func (c Credentials) MarshalJSON() ([]byte, error) {
	token := c.Token
	if token != "" {
		token = RedactedToken
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(secretCredentials{
		Token:     token,
		BaseURL:   c.BaseURL,
		AccountID: c.AccountID,
		UserID:    c.UserID,
	}); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n")), nil
}

func (c Credentials) safeString() string {
	value := c.Token
	if value != "" {
		value = RedactedToken
	}
	return fmt.Sprintf("Credentials{token=%q baseUrl=%q accountId=%q userId=%q}", value, c.BaseURL, c.AccountID, c.UserID)
}

func (c Credentials) String() string { return c.safeString() }

func (c Credentials) GoString() string { return c.safeString() }

// Format covers %v, %+v, %#v and %s alike.
func (c Credentials) Format(state fmt.State, _ rune) {
	fmt.Fprint(state, c.safeString())
}

func (c Credentials) LogValue() slog.Value {
	token := c.Token
	if token != "" {
		token = RedactedToken
	}
	return slog.GroupValue(
		slog.String("token", token),
		slog.String("baseUrl", c.BaseURL),
		slog.String("accountId", c.AccountID),
		slog.String("userId", c.UserID),
	)
}

type loginClient interface {
	GetBotQRCode(ctx context.Context) (QRCode, error)
	GetQRStatus(ctx context.Context, qrcode string) (QRStatus, error)
}

// Login runs QR login against the public iLink origin. It polls every two
// seconds and refreshes at most three QR codes. Cancelling ctx prevents a late
// confirmed response from being returned.
func Login(ctx context.Context, onStatus func(LoginStatus)) (Credentials, error) {
	return loginWith(ctx, NewClient(), sleepContext, onStatus)
}

func loginWith(
	ctx context.Context,
	client loginClient,
	sleep func(context.Context, time.Duration) error,
	onStatus func(LoginStatus),
) (Credentials, error) {
	operationID, err := newOperationID()
	if err != nil {
		return Credentials{}, err
	}
	emit := func(state, phase, qr string) {
		if onStatus == nil {
			return
		}
		onStatus(LoginStatus{
			OperationID: operationID,
			State:       state,
			Phase:       phase,
			QRContent:   qr,
		})
	}

	for attempt := 0; attempt < maxQRRefresh; attempt++ {
		if err := ctx.Err(); err != nil {
			emit(LoginCancelled, "cancelled", "")
			return Credentials{}, err
		}

		qr, err := client.GetBotQRCode(ctx)
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				emit(LoginCancelled, "cancelled", "")
				return Credentials{}, ctxErr
			}
			return Credentials{}, err
		}
		emit(LoginWaiting, "prompt", qr.ImageContent)
		lastState := LoginWaiting

		for {
			if err := sleep(ctx, pollInterval); err != nil {
				emit(LoginCancelled, "cancelled", qr.ImageContent)
				return Credentials{}, err
			}

			status, err := client.GetQRStatus(ctx, qr.QRCode)
			if err != nil {
				if ctxErr := ctx.Err(); ctxErr != nil {
					emit(LoginCancelled, "cancelled", qr.ImageContent)
					return Credentials{}, ctxErr
				}
				return Credentials{}, err
			}
			if err := ctx.Err(); err != nil {
				emit(LoginCancelled, "cancelled", qr.ImageContent)
				return Credentials{}, err
			}

			switch status.State {
			case QRWait:
				if lastState != LoginWaiting {
					emit(LoginWaiting, "pending", qr.ImageContent)
				}
				lastState = LoginWaiting
			case QRScanned:
				emit(LoginScanned, "scanned", qr.ImageContent)
				lastState = LoginScanned
			case QRExpired:
				emit(LoginExpired, "expired", qr.ImageContent)
				lastState = LoginExpired
				goto nextQR
			case QRConfirmed:
				credentials, err := credentialsFromQRStatus(status.Raw)
				if err != nil {
					return Credentials{}, err
				}
				if err := ctx.Err(); err != nil {
					emit(LoginCancelled, "cancelled", qr.ImageContent)
					return Credentials{}, err
				}
				emit(LoginConfirmed, "confirmed", qr.ImageContent)
				return credentials, nil
			}
		}

	nextQR:
	}

	return Credentials{}, ErrQRExpired
}

func credentialsFromQRStatus(raw map[string]any) (Credentials, error) {
	credentials := Credentials{
		Token:     readString(raw, "bot_token"),
		BaseURL:   readString(raw, "baseurl"),
		AccountID: readString(raw, "ilink_bot_id"),
		UserID:    readString(raw, "ilink_user_id"),
	}
	if credentials.Token == "" || credentials.BaseURL == "" ||
		credentials.AccountID == "" || credentials.UserID == "" {
		return Credentials{}, ErrCredentialsIncomplete
	}
	if !IsTrustedBaseURL(credentials.BaseURL) {
		return Credentials{}, ErrUntrustedBaseURL
	}
	return credentials, nil
}

func newOperationID() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", fmt.Errorf("wechat: generate operation id: %w", err)
	}
	return hex.EncodeToString(bytes[:]), nil
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
