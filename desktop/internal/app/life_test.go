package app

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/deskwand/bot/desktop/internal/backup"
	"github.com/deskwand/bot/desktop/internal/domain"
)

func TestLifeVitalsMapsTheWorkerPayload(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/admin/life/vitals" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"balanceUsd":42.5,"dailySpendUsd":1.85,"runwayDays":23,"tier":"ample","metabolismStarted":true,"unpriced":false,"topSources":[{"source":"butler","usd":6.1}]}`))
	})
	fixture := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, handler)

	vitals, err := fixture.service.LifeVitals()
	if err != nil {
		t.Fatalf("LifeVitals: %v", err)
	}
	if vitals.BalanceUSD != 42.5 || vitals.DailySpendUSD != 1.85 {
		t.Fatalf("vitals = %#v", vitals)
	}
	if vitals.RunwayDays == nil || *vitals.RunwayDays != 23 {
		t.Fatalf("runwayDays = %#v", vitals.RunwayDays)
	}
	if vitals.Tier != "ample" || !vitals.MetabolismStarted || vitals.Unpriced {
		t.Fatalf("vitals = %#v", vitals)
	}
	if len(vitals.TopSources) != 1 || vitals.TopSources[0].Source != "butler" || vitals.TopSources[0].USD != 6.1 {
		t.Fatalf("topSources = %#v", vitals.TopSources)
	}
}

func TestLifeVitalsReturnsAnEmptySourceList(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/admin/life/vitals" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"balanceUsd":0,"dailySpendUsd":0,"runwayDays":null,"tier":"ample","metabolismStarted":false,"unpriced":false,"topSources":[]}`))
	})
	fixture := newMcpFixture(t, `[]`, []string{"ADMIN_TOKEN"}, handler)

	vitals, err := fixture.service.LifeVitals()
	if err != nil {
		t.Fatalf("LifeVitals: %v", err)
	}
	encoded, err := json.Marshal(vitals)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if !strings.Contains(string(encoded), `"topSources":[]`) {
		t.Fatalf("topSources is not an empty array: %s", encoded)
	}
}

func TestAdminClientsConnectOneAtATime(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/admin/backup/info":
			// Connect waits for the admin route after publishing; a lease
			// refusal already proves the route is live.
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"code":"MAINTENANCE_REQUIRED"}`))
		case "/admin/wallet/status":
			_, _ = w.Write([]byte(`{"configured":false}`))
		case "/admin/life/vitals":
			_, _ = w.Write([]byte(`{"balanceUsd":0,"dailySpendUsd":0,"runwayDays":null,"tier":"ample","metabolismStarted":false,"unpriced":false,"topSources":[]}`))
		default:
			http.NotFound(w, r)
		}
	})
	fixture := newMcpFixture(t, `[]`, []string{}, handler)

	var inPublish, overlapped int32
	fixture.publish.onApply = func(change domain.Change) {
		if atomic.AddInt32(&inPublish, 1) > 1 {
			atomic.StoreInt32(&overlapped, 1)
		}
		// Hold the publish window open long enough for the other client to
		// reach its own Connect when the mutex is missing.
		time.Sleep(50 * time.Millisecond)
		for _, secret := range change.Secrets {
			if secret.Name == backup.AdminTokenSecret {
				fixture.snapshots.addSecret(secret.Name)
			}
		}
		atomic.AddInt32(&inPublish, -1)
	}

	var wg sync.WaitGroup
	var walletErr, lifeErr error
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, walletErr = fixture.service.WalletStatus()
	}()
	go func() {
		defer wg.Done()
		_, lifeErr = fixture.service.LifeVitals()
	}()
	wg.Wait()

	if walletErr != nil {
		t.Fatalf("WalletStatus: %v", walletErr)
	}
	if lifeErr != nil {
		t.Fatalf("LifeVitals: %v", lifeErr)
	}

	fixture.publish.mu.Lock()
	publishes := len(fixture.publish.changes)
	fixture.publish.mu.Unlock()
	if publishes != 1 {
		t.Fatalf("ADMIN_TOKEN was published %d times, want 1", publishes)
	}
	if atomic.LoadInt32(&overlapped) != 0 {
		t.Fatal("two Connect calls published at the same time")
	}
}
