import type { Extension } from "@earendil-works/pi-durable";
import { artifactStore } from "../artifact-store";
import type { Locale } from "../i18n";
import type { TaskEventBody } from "../protocol";
import { sandboxEnabled } from "./config";
import { httpSandboxProvider } from "./http";
import { sandboxSectionText } from "./section";
import { createSandboxTools } from "./tools";

export type SandboxInstallDeps = {
  taskId: () => string;
  locale: () => Locale;
  timeoutMs?: number;
  progress?: (body: TaskEventBody) => Promise<void>;
  guard?: () => Promise<void>;
  fetchImpl?: typeof fetch;
};

/**
 * The sandbox tools and their prompt section, or `null` when the deployment has
 * no sandbox (or the config turns it off). A null extension is what keeps
 * unconfigured deployments byte-for-byte unchanged.
 */
export function sandboxExtension(
  env: Env,
  deps: SandboxInstallDeps,
): Extension | null {
  const provider = httpSandboxProvider(env, deps.fetchImpl ?? fetch);
  if (provider === null) return null;
  if (!sandboxEnabled(env)) return null;
  return {
    name: "sandbox",
    tools: createSandboxTools(provider, {
      bucket: artifactStore(env),
      taskId: deps.taskId,
      locale: deps.locale,
      timeoutMs: deps.timeoutMs,
      progress: deps.progress,
      guard: deps.guard,
    }),
    sections: [{ key: "sandbox", render: () => sandboxSectionText() }],
  };
}
