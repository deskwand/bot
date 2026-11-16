package app

import (
	"context"
	"errors"

	"github.com/egoist/mygo"

	"github.com/deskwand/bot/desktop/internal/browseradmin"
	"github.com/deskwand/bot/desktop/internal/domain"
)

// BrowserFrameEvent carries one screen frame to the takeover page. The frame
// lives only in memory: it is emitted as an event and never written anywhere.
var BrowserFrameEvent = mygo.NewEvent[BrowserFrameDTO]("browser-frame")

// BrowserFrameDTO is one JPEG frame, still base64-encoded.
type BrowserFrameDTO struct {
	Seq  int    `json:"seq"`
	JPEG string `json:"jpeg"`
	W    int    `json:"w"`
	H    int    `json:"h"`
}

// BrowserStreamEvent carries the URL a frame belongs to, or why the stream ended.
var BrowserStreamEvent = mygo.NewEvent[BrowserStreamDTO]("browser-stream")

// BrowserStreamDTO is either "state" (a new URL) or "end" (with a reason).
type BrowserStreamDTO struct {
	Kind   string `json:"kind"`
	URL    string `json:"url,omitempty"`
	Reason string `json:"reason,omitempty"`
}

// BrowserStatusDTO tells the page whether takeover can run at all.
type BrowserStatusDTO struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
}

// BrowserOpenedDTO names the page the takeover tab now shows.
type BrowserOpenedDTO struct {
	URL   string `json:"url"`
	Title string `json:"title"`
}

// BrowserEventDTO is one mouse or key action, in frame coordinates.
type BrowserEventDTO struct {
	Type   string  `json:"type"`
	Kind   string  `json:"kind"`
	X      int     `json:"x,omitempty"`
	Y      int     `json:"y,omitempty"`
	Button string  `json:"button,omitempty"`
	DeltaY float64 `json:"deltaY,omitempty"`
	Text   string  `json:"text,omitempty"`
	Key    string  `json:"key,omitempty"`
}

type browserStream struct {
	cancel context.CancelFunc
	done   chan struct{}
}

func (s *Service) browserClient(ctx context.Context, target domain.Target) (*browseradmin.Client, error) {
	if s.endpoints == nil {
		return nil, s.serviceUnavailable()
	}
	endpoint, err := s.endpoints.Resolve(ctx, target)
	if err != nil {
		return nil, safeAppError(err)
	}
	client := browseradmin.NewClient(endpoint.BaseURL, endpoint.Token, endpoint.HTTP)
	client.Locale = s.locale.Current
	if s.browserSilentAfter > 0 {
		client.SilentAfter = s.browserSilentAfter
	}
	return client, nil
}

// BrowserStatus tells the takeover page whether it has anything to talk to.
func (s *Service) BrowserStatus() (BrowserStatusDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return BrowserStatusDTO{}, err
	}
	client, err := s.browserClient(ctx, target)
	if err != nil {
		return BrowserStatusDTO{}, err
	}
	status, err := client.Status(ctx)
	if err != nil {
		return BrowserStatusDTO{}, s.adminFailure(err)
	}
	return BrowserStatusDTO{Available: status.Available, Reason: status.Reason}, nil
}

// BrowserOpen points the takeover view at url; an empty url attaches to
// whatever page the sandbox browser is already showing.
func (s *Service) BrowserOpen(url string) (BrowserOpenedDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return BrowserOpenedDTO{}, err
	}
	client, err := s.browserClient(ctx, target)
	if err != nil {
		return BrowserOpenedDTO{}, err
	}
	opened, err := client.Open(ctx, url)
	if err != nil {
		return BrowserOpenedDTO{}, s.adminFailure(err)
	}
	return BrowserOpenedDTO{URL: opened.URL, Title: opened.Title}, nil
}

// BrowserInput reports whether the sandbox took the events; a stale frame is
// false with a nil error, because that is an expected race.
func (s *Service) BrowserInput(seq int, events []BrowserEventDTO) (bool, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return false, err
	}
	client, err := s.browserClient(ctx, target)
	if err != nil {
		return false, err
	}
	converted := make([]browseradmin.Event, 0, len(events))
	for _, event := range events {
		converted = append(converted, browseradmin.Event{
			Type:   event.Type,
			Kind:   event.Kind,
			X:      event.X,
			Y:      event.Y,
			Button: event.Button,
			DeltaY: event.DeltaY,
			Text:   event.Text,
			Key:    event.Key,
		})
	}
	result, err := client.Input(ctx, seq, converted)
	if err != nil {
		return false, s.adminFailure(err)
	}
	return result.OK, nil
}

// BrowserClose drops the takeover tab.
func (s *Service) BrowserClose() error {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return err
	}
	client, err := s.browserClient(ctx, target)
	if err != nil {
		return err
	}
	if err := client.Close(ctx); err != nil {
		return s.adminFailure(err)
	}
	return nil
}

// BrowserStreamStart runs until the page stops it or the stream ends by itself.
func (s *Service) BrowserStreamStart() error {
	s.browserStreamMu.Lock()
	defer s.browserStreamMu.Unlock()
	if s.browserStream != nil {
		return nil
	}
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return err
	}
	client, err := s.browserClient(ctx, target)
	if err != nil {
		return err
	}
	streamCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	stream := &browserStream{cancel: cancel, done: done}
	s.browserStream = stream
	emit := s.emitBrowserFrame
	emitState := s.emitBrowserStream
	go func() {
		defer close(done)
		// The stream ends on its own all the time (a second open supersedes it,
		// the tab is swept, the sandbox restarts). Clearing the field here is
		// what makes the next start work instead of being a silent no-op.
		defer func() {
			s.browserStreamMu.Lock()
			if s.browserStream == stream {
				s.browserStream = nil
			}
			s.browserStreamMu.Unlock()
		}()
		err := client.Stream(streamCtx, func(frame browseradmin.Frame) error {
			emit(BrowserFrameDTO{Seq: frame.Seq, JPEG: frame.JPEG, W: frame.W, H: frame.H})
			return nil
		}, func(state browseradmin.StreamState) error {
			emitState(BrowserStreamDTO{Kind: state.Kind, URL: state.URL, Reason: state.Reason})
			return nil
		})
		if err != nil && !errors.Is(err, context.Canceled) {
			// The panel learns a stream is over only from an end event; a transport
			// error used to vanish here and leave the last frame on screen. A caller
			// cancellation is not that: the panel closed itself.
			reason := "closed"
			if errors.Is(err, browseradmin.ErrSilent) {
				reason = "silent"
			}
			emitState(BrowserStreamDTO{Kind: "end", Reason: reason})
		}
	}()
	return nil
}

// BrowserStreamStop cancels and waits: a goroutine that outlived the page would
// keep pushing frames into a window nobody is watching.
func (s *Service) BrowserStreamStop() {
	s.browserStreamMu.Lock()
	stream := s.browserStream
	s.browserStream = nil
	s.browserStreamMu.Unlock()
	if stream == nil {
		return
	}
	stream.cancel()
	<-stream.done
}

// browserTakenOver reports whether a stream is running, for tests and logs.
func (s *Service) browserTakenOver() bool {
	s.browserStreamMu.Lock()
	defer s.browserStreamMu.Unlock()
	return s.browserStream != nil
}
