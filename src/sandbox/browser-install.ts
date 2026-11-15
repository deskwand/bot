import type { Extension } from "@earendil-works/pi-durable";
import { artifactStore } from "../artifact-store";
import { browseTool } from "../tools/browser";
import { browserClient } from "./browser-http";
import type { SandboxFetch } from "./http";
import { sandboxEnabled } from "./config";
import { sandboxFetch } from "./install";

export type BrowserInstallDeps = {
  taskId: () => string;
  fetchImpl?: SandboxFetch;
};

/**
 * The browser is part of the sandbox, not a separate capability: no sandbox, no
 * tool. The image's own `features` list is checked on the first call.
 */
export function browserExtension(env: Env, deps: BrowserInstallDeps): Extension | null {
  if (!sandboxEnabled(env)) return null;
  const client = browserClient(env, deps.fetchImpl ?? sandboxFetch(env) ?? fetch);
  if (client === null) return null;
  return {
    name: "browser",
    tools: [browseTool({ client, taskId: deps.taskId, bucket: artifactStore(env) })],
    sections: [{ key: "browser", render: () => browserSectionText() }],
  };
}

/** Kept short: this costs tokens on every task that has a sandbox. */
export function browserSectionText(): string {
  return [
    "## Browser",
    "",
    "`browse` drives a real Chromium on the sandbox machine: it runs JavaScript, keeps cookies, and remembers logins across tasks and restarts.",
    "",
    "- Act on element numbers from the last snapshot (`e4`); only reach for a CSS selector when nothing usable was listed.",
    '- `page moved — read it again` means the numbers are stale: run `read`, then act on the new ones. Never retry the old number.',
    "- Take a screenshot when words are not enough to tell what happened, or to show the owner. At most 3 per task.",
    "- Ask the owner for passwords, one-time codes and payment details. Do not guess them.",
    "- If the tool says the sandbox image has no browser, tell the owner and stop: retrying cannot fix it.",
  ].join("\n");
}
