package container

import (
	"context"
	"strings"
	"time"

	"github.com/deskwand/bot/desktop/internal/domain"
)

// SandboxImageRepository is the repository compose.yaml.tmpl names for the
// sandbox service.
const SandboxImageRepository = "ghcr.io/deskwand/sandbox"

// prunedRepositories lists the repositories a deploy can leave a stale image in.
// TestPrunedRepositoriesCoverComposeTemplate keeps it in step with the compose
// template, so a new service cannot be silently left out.
var prunedRepositories = []string{ImageRepository, SandboxImageRepository}

// pruneTimeout bounds the cleanup. It stays under lockWait (60s) because the
// cleanup runs while holding the target lock and s.mu: a backup or restore that
// starts meanwhile has to be able to wait the cleanup out, and a status read
// from the app must not hang behind it. Deleting two images takes seconds, so
// running out of time here only means they wait for the next deploy.
const pruneTimeout = 45 * time.Second

// pruneScript keeps every image reference a container on the host uses and
// deletes the rest of this project's own images. Three details matter:
// references rather than image ids keep "docker inspect" out of the command,
// which the fake hosts use to recognize a status query; the case patterns are
// exact, because "docker images <repo>" also matches sibling repositories by
// prefix; and "docker rmi" carries no -f, so Docker refuses an image a container
// is using instead of us having to enumerate them all again.
func pruneScript() string {
	patterns := make([]string, 0, len(prunedRepositories))
	for _, repo := range prunedRepositories {
		patterns = append(patterns, repo+":*")
	}
	var script strings.Builder
	script.WriteString(`live=$(docker ps -a --format '{{.Image}}' | sort -u)` + "\n")
	script.WriteString(`docker images --format '{{.Repository}}:{{.Tag}}' | grep -v '<none>$' | sort -u | while read -r ref; do` + "\n")
	script.WriteString("  case \"$ref\" in\n")
	script.WriteString("    " + strings.Join(patterns, "|") + ") ;;\n")
	script.WriteString("    *) continue ;;\n")
	script.WriteString("  esac\n")
	script.WriteString("  printf '%s\\n' \"$live\" | grep -Fqx \"$ref\" && continue\n")
	script.WriteString("  docker rmi \"$ref\" >/dev/null 2>&1 || true\n")
	script.WriteString("done\n")
	return script.String()
}

// pruneImages drops the images this project's earlier deploys left behind. The
// deploy has already succeeded, so a transport error and a nonzero exit are both
// dropped here rather than turned into a deploy failure.
func (s *Service) pruneImages(ctx context.Context, target domain.Target, host Host) {
	if target.Host.IsLocal() {
		// A local target runs this Mac's Docker or Apple's container tool. Those
		// images belong to the person using the client, so removing them is
		// their call, not ours.
		return
	}
	pruneCtx, cancel := context.WithTimeout(ctx, pruneTimeout)
	defer cancel()
	_, _ = host.Run(pruneCtx, pruneScript(), nil)
}
