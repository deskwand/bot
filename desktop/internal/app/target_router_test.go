package app

import (
	"context"
	"testing"

	"github.com/deskwand/bot/desktop/internal/domain"
)

func routerContainerTarget() domain.Target {
	return domain.Target{
		Kind: domain.TargetContainer,
		Host: domain.HostRef{
			Address: "192.0.2.10",
			Port:    22,
			User:    "root",
			Auth:    domain.SSHAuthPassword,
			Dir:     "~/deskwand",
		},
	}
}

func TestPublishRouterDispatchesByKind(t *testing.T) {
	ctx := context.Background()
	cloudflare := &fakePublish{}
	container := &fakeContainer{}
	router := &PublishRouter{Cloudflare: cloudflare, Container: container}

	if _, err := router.Apply(ctx, routerContainerTarget(), domain.Change{}); err != nil {
		t.Fatal(err)
	}
	if container.applyCalls != 1 || len(cloudflare.changes) != 0 {
		t.Fatalf("container apply = %d, cloudflare = %d", container.applyCalls, len(cloudflare.changes))
	}
	if _, err := router.Apply(ctx, domain.Target{}, domain.Change{}); err != nil {
		t.Fatal(err)
	}
	if len(cloudflare.changes) != 1 {
		t.Fatalf("cloudflare apply = %d", len(cloudflare.changes))
	}
	if _, err := router.Resume(ctx, "op-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := router.Abandon(ctx, "op-1"); err != nil {
		t.Fatal(err)
	}
	if cloudflare.resumeID != "op-1" || cloudflare.abandonID != "op-1" {
		t.Fatalf("resume = %q, abandon = %q", cloudflare.resumeID, cloudflare.abandonID)
	}
}

func TestSnapshotAndStatusRoutersDispatchByKind(t *testing.T) {
	ctx := context.Background()
	cloudflare := &fakeSnapshots{snapshot: domain.Snapshot{Fingerprint: "cloudflare"}}
	container := &fakeContainer{snapshot: domain.Snapshot{Fingerprint: "container"}}
	snapshots := &SnapshotRouter{Cloudflare: cloudflare, Container: container}

	if snapshot, err := snapshots.ReadSnapshot(ctx, routerContainerTarget()); err != nil || snapshot.Fingerprint != "container" {
		t.Fatalf("container snapshot = %#v, %v", snapshot, err)
	}
	if snapshot, err := snapshots.ReadSnapshot(ctx, domain.Target{}); err != nil || snapshot.Fingerprint != "cloudflare" {
		t.Fatalf("cloudflare snapshot = %#v, %v", snapshot, err)
	}
	if container.snapshotCalls != 1 || cloudflare.calls != 1 {
		t.Fatalf("snapshot calls = %d / %d", container.snapshotCalls, cloudflare.calls)
	}

	cloudflareStatus := &fakeStatus{report: DiagnosticsReport{AccountID: "cloudflare"}}
	containerStatus := &fakeStatus{report: DiagnosticsReport{AccountID: "container"}}
	statuses := &StatusRouter{Cloudflare: cloudflareStatus, Container: containerStatus}

	report, err := statuses.Status(ctx, routerContainerTarget())
	if err != nil || report.AccountID != "container" {
		t.Fatalf("container status = %#v, %v", report, err)
	}
	report, err = statuses.Status(ctx, domain.Target{})
	if err != nil || report.AccountID != "cloudflare" {
		t.Fatalf("cloudflare status = %#v, %v", report, err)
	}
	if cloudflareStatus.calls != 1 || containerStatus.calls != 1 {
		t.Fatalf("status calls = %d / %d", containerStatus.calls, cloudflareStatus.calls)
	}
}
