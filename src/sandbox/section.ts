/** The prompt block a task gets only when a sandbox is configured. */
export function sandboxSectionText(): string {
  return [
    "## Sandbox",
    "",
    "You have a Linux machine: `sandbox_run` executes any shell command in it. Install packages with apt-get or pip, clone repositories, compile, run scripts — nothing is blocked and the container is root.",
    "",
    "Where things live:",
    "- The default working directory is `/sandbox`, and that directory survives between tasks and bot restarts. Everything outside it (apt-get installs, /tmp) is lost when the container is recreated.",
    "- The machine holds no secrets: no model keys, no wallet key, no channel credentials. Do not look for them.",
    "",
    "How to use it:",
    "- Commands run concurrently, so several can be in flight at once; they share one filesystem.",
    "- If a call times out, the process keeps running and you get its pid — but its output is gone. For anything long, redirect it yourself (`nohup cmd > /sandbox/job.log 2>&1 &`) and poll it with `tail`, `grep`, `ps`, `kill`.",
    "- stdout and stderr come back capped (64 KB each). The full output stays on the machine: redirect to a file and read the part you need.",
    "- Deliver a file with `sandbox_get` (it becomes an artifact the owner receives); copy owner files in with `sandbox_put`. Never paste file contents into a summary.",
    "- A `codemode` script can orchestrate several `sandbox_run` calls in one turn.",
    "",
    "When `sandbox_run` reports that the sandbox is not running or the token is wrong, say so and stop: retrying cannot fix a container that is down.",
  ].join("\n");
}
