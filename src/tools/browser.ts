import { Type } from "typebox";
import type {
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { MAX_ARTIFACT_BYTES, artifactKeySegments, sanitizeFilename } from "../artifact";
import type { ArtifactStore } from "../artifact-store";
import type { BrowserClient, Snapshot } from "../sandbox/browser-http";
import { sandboxPathFromDraft } from "../sandbox/paths";
import type { SandboxProvider } from "../sandbox/types";
import { writeArtifact } from "./artifacts";
import { callAcceptsImages, renderFile } from "./file-content";
import { isBlockedHost } from "./http-request";

const Browse = Type.Object({
  action: Type.Union(
    [
      Type.Literal("open"),
      Type.Literal("click"),
      Type.Literal("fill"),
      Type.Literal("press"),
      Type.Literal("back"),
      Type.Literal("read"),
      Type.Literal("shot"),
      Type.Literal("upload"),
      Type.Literal("download"),
    ],
    {
      description:
        "open loads a url; click/fill act on an element number from the last snapshot (or a CSS selector); press sends a key; back goes through history; read re-reads the page without acting; shot saves a screenshot; upload puts a file into a file input; download catches the file a click starts.",
    },
  ),
  url: Type.Optional(Type.String({ description: "Required for open. http(s) only." })),
  target: Type.Optional(
    Type.String({
      description:
        'Element number from the last snapshot, like "e4", or a CSS selector when nothing usable was listed. File inputs are usually invisible, so upload wants a selector like input[type=file].',
    }),
  ),
  text: Type.Optional(Type.String({ description: "Required for fill." })),
  key: Type.Optional(
    Type.String({ description: 'Required for press, like "Enter" or "Tab".' }),
  ),
  fullPage: Type.Optional(
    Type.Boolean({ description: "For shot: capture the whole scrollable page." }),
  ),
  source: Type.Optional(
    Type.String({
      description:
        'For upload: "artifact:<key>" or a workspace path like "/draft.csv".',
    }),
  ),
});

export type BrowseArgs = {
  action: "open" | "click" | "fill" | "press" | "back" | "read" | "shot" | "upload" | "download";
  url?: string;
  target?: string;
  text?: string;
  key?: string;
  fullPage?: boolean;
  source?: string;
};

const UNSUPPORTED =
  "sandbox image has no browser — ask the owner to upgrade the sandbox image, then stop";
const DOWN = "sandbox is not reachable — stop retrying";
const NO_UPLOAD =
  "the sandbox image is too old to upload files — ask the owner to upgrade the sandbox image, then stop";
const NO_DOWNLOAD =
  "the sandbox image is too old to download files — ask the owner to upgrade the sandbox image, then stop";

function text(body: string, isError = false): ToolExecutionResult {
  return { output: [{ type: "text", text: body }], isError };
}

/** The hostname a url points at, or null when it is not a usable http(s) url. */
export function hostOf(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname;
  } catch {
    return null;
  }
}

export function renderSnapshot(snapshot: Snapshot): string {
  const lines = [
    `URL: ${snapshot.url}`,
    `TITLE: ${snapshot.title}`,
    "",
    snapshot.text,
    "",
    "Interactive:",
  ];
  for (const element of snapshot.elements) {
    const parts = [element.ref, element.role];
    if (element.name !== "") parts.push(`"${element.name}"`);
    if (element.type !== undefined && element.type !== "text") parts.push(`type=${element.type}`);
    if (element.placeholder !== undefined) parts.push(`placeholder=${element.placeholder}`);
    if (element.href !== undefined) parts.push(`→ ${element.href}`);
    if (element.checked === true) parts.push("(checked)");
    lines.push(parts.join(" "));
  }
  if (snapshot.elements.length === 0) {
    lines.push("(none visible — pass a CSS selector as target to act on something unlisted)");
  } else if (snapshot.truncated.elements || snapshot.truncated.filtered > 0) {
    const count = snapshot.truncated.elements ? "more" : String(snapshot.truncated.filtered);
    lines.push(`(${count} elements were not listed — pass a CSS selector as target to act on one)`);
  }
  return lines.join("\n");
}

function validate(args: BrowseArgs): string | null {
  if (args.action === "open") {
    return args.url === undefined || args.url === "" ? "open needs a url" : null;
  }
  if (args.action === "click") {
    return args.target === undefined || args.target === "" ? "click needs a target" : null;
  }
  if (args.action === "fill") {
    if (args.target === undefined || args.target === "") return "fill needs a target";
    return args.text === undefined ? "fill needs text" : null;
  }
  if (args.action === "press") {
    return args.key === undefined || args.key === "" ? "press needs a key" : null;
  }
  if (args.action === "upload") {
    if (args.target === undefined || args.target === "") return "upload needs a target";
    return args.source === undefined || args.source === "" ? "upload needs a source" : null;
  }
  if (args.action === "download") {
    return args.target === undefined || args.target === "" ? "download needs a target" : null;
  }
  return null;
}

export type BrowseToolDeps = {
  client: BrowserClient;
  taskId: () => string;
  bucket: ArtifactStore;
  /** Absent only when the sandbox has no file channel; upload/download then refuse. */
  files: Pick<SandboxProvider, "readFile" | "writeFile"> | null;
};

export function browseTool(deps: BrowseToolDeps): ToolRegistration<typeof Browse> {
  /** Set once the sandbox reports it has no browser: never ask again this task. */
  let unsupported = false;
  let hasBrowser = false;
  let caps: Set<string> | null = null;
  let shots = 0;
  /** One automatic screenshot per distinct failure, at most two per tool instance. */
  const AUTO_SHOTS = 2;
  let autoShots = 0;
  const autoShotFor = new Set<string>();

  async function capabilities(): Promise<Set<string>> {
    if (caps === null) caps = new Set(await deps.client.features());
    return caps;
  }

  /** A navigation can land anywhere: refuse anything that is not a public http(s) page. */
  async function checkLanding(snapshot: Snapshot): Promise<ToolExecutionResult> {
    const landed = hostOf(snapshot.url);
    if (landed === null) {
      await deps.client.close(deps.taskId()).catch(() => {});
      return text(`landed on a non-http(s) page (${snapshot.url}) — tab closed`, true);
    }
    if (isBlockedHost(landed)) {
      await deps.client.close(deps.taskId()).catch(() => {});
      return text(`blocked host: ${landed}`, true);
    }
    return text(renderSnapshot(snapshot));
  }

  return {
    name: "browse",
    description:
      "Drive a real headless Chromium inside the sandbox: open a page, read what is on it, click and fill by element number, go back, and take a screenshot the owner can see. Cookies persist across tasks, so a login done once keeps working.",
    parameters: Browse,
    replay: "unsafe",
    async execute(args, api, context) {
      const input = args as BrowseArgs;
      if (unsupported) return text(UNSUPPORTED);

      const problem = validate(input);
      if (problem !== null) return text(problem, true);
      if (deps.taskId() === "") return text("task has not started", true);

      if (!hasBrowser) {
        // One probe per task: an HTTP round trip on every call would be silly,
        // and the answer cannot change while the container lives.
        try {
          hasBrowser = (await capabilities()).has("browser");
        } catch (error) {
          return text(error instanceof Error ? error.message : DOWN, true);
        }
        if (!hasBrowser) {
          unsupported = true;
          return text(UNSUPPORTED);
        }
      }

      const failWithShot = async (
        action: BrowseArgs["action"],
        error: unknown,
      ): Promise<ToolExecutionResult> => {
        const message = error instanceof Error ? error.message : String(error);
        const worth = action === "click" || action === "fill" || action === "press";
        if (!worth || autoShots >= AUTO_SHOTS || autoShotFor.has(message)) {
          return text(message, true);
        }
        // When the api cannot say whether the model sees images, do not attach one.
        try {
          if (!(await callAcceptsImages(api, context))) return text(message, true);
        } catch {
          return text(message, true);
        }
        let png: Uint8Array;
        try {
          png = await deps.client.shot(deps.taskId(), false);
        } catch {
          return text(message, true);
        }
        const header = `${message}\na screenshot of the page is attached`;
        try {
          const name = `browse-fail-${String(autoShots + 1)}.png`;
          const key = await writeArtifact(deps.bucket, deps.taskId(), png, name, "image/png");
          const rendered = await renderFile(
            { bytes: png, name, mimeType: "image/png", kind: "image", header },
            { convert: undefined, acceptsImages: () => Promise.resolve(true) },
          );
          // A failed re-encode must not swallow the original error.
          if (rendered.isError === true) return text(message, true);
          // Spend the budget only once the image is actually in hand.
          autoShots += 1;
          autoShotFor.add(message);
          return {
            ...rendered,
            isError: true,
            output: [
              { type: "text", text: `${header}\nartifact: ${key}` },
              ...(rendered.output ?? []).slice(1),
            ],
          };
        } catch {
          return text(message, true);
        }
      };

      try {
        if (input.action === "upload") {
          if (deps.files === null) return text(NO_UPLOAD, true);
          if (!(await capabilities()).has("browser-upload")) return text(NO_UPLOAD, true);

          const wanted = input.source!;
          if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(wanted) && !wanted.startsWith("artifact:")) {
            return text(
              `cannot upload ${wanted} — pass "artifact:<key>" or a workspace path like "/draft.csv"`,
              true,
            );
          }
          const key = wanted.startsWith("artifact:")
            ? wanted.slice("artifact:".length)
            : sandboxPathFromDraft(deps.taskId(), wanted);
          // A workspace key starts with `work/`, so ownership only applies to artifacts.
          if (wanted.startsWith("artifact:")) {
            const segments = artifactKeySegments(key);
            if (segments === null || segments[0] !== deps.taskId()) {
              return text(`cannot upload that artifact: ${key}`, true);
            }
          }
          const object = await deps.bucket.get(key);
          if (object === null) {
            return text(
              `no such file: ${wanted} — pass "artifact:<key>" or a workspace path like "/draft.csv"`,
              true,
            );
          }
          const bytes = new Uint8Array(await object.arrayBuffer());
          if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
            return text(
              `file is ${String(bytes.byteLength)} bytes — the upload limit is ${String(MAX_ARTIFACT_BYTES)}`,
              true,
            );
          }
          const name = sanitizeFilename(key.split("/").pop() ?? "upload.bin");
          const path = `/tmp/dw-uploads/${crypto.randomUUID()}/${name}`;
          await deps.files.writeFile(path, bytes);
          return await checkLanding(await deps.client.upload(deps.taskId(), input.target!, path));
        }

        if (input.action === "download") {
          if (deps.files === null) return text(NO_DOWNLOAD, true);
          if (!(await capabilities()).has("browser-download")) return text(NO_DOWNLOAD, true);
          const result = await deps.client.download(deps.taskId(), input.target!);
          const landed = hostOf(result.snapshot.url);
          if (landed === null || isBlockedHost(landed)) return await checkLanding(result.snapshot);
          if (result.size > MAX_ARTIFACT_BYTES) {
            return text(
              `downloaded ${result.name} (${String(result.size)} bytes) — too big to keep as an artifact. ` +
                `It stays in the sandbox at ${result.path} for 1 hour; use exec to unpack or trim it, then download again.`,
            );
          }
          const bytes = await deps.files.readFile(result.path, MAX_ARTIFACT_BYTES + 1);
          // Only enforce when the sandbox actually reported a size: a missing field
          // must not turn every download into a failure, and must not reach the
          // message as "undefined bytes".
          const reported = typeof result.size === "number" ? result.size : null;
          if (reported !== null && bytes.byteLength !== reported) {
            return text(
              `downloaded ${result.name}: the sandbox reported ${String(reported)} bytes but ` +
                `${String(bytes.byteLength)} came back — nothing was saved. It is still in the sandbox ` +
                `at ${result.path} for 1 hour; use exec to trim it and download again.`,
              true,
            );
          }
          const key = await writeArtifact(
            deps.bucket,
            deps.taskId(),
            bytes,
            result.name,
            "application/octet-stream",
          );
          return text(
            `downloaded ${result.name} (${String(reported ?? bytes.byteLength)} bytes) as artifact ${key}\n\n` +
              renderSnapshot(result.snapshot),
          );
        }

        if (input.action === "shot") {
          let png: Uint8Array;
          let pageUrl: string;
          try {
            // Read first: the screenshot names itself after the page, and a
            // stale tab is worth reporting before a blind capture.
            pageUrl = (await deps.client.act(deps.taskId(), "read")).url;
            png = await deps.client.shot(deps.taskId(), input.fullPage === true);
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
          }

          shots += 1;
          const name = `browse-${String(shots)}.png`;
          let key: string;
          try {
            key = await writeArtifact(deps.bucket, deps.taskId(), png, name, "image/png");
          } catch {
            // A lost image is not a lost action: say where the page is and move on.
            return text(`screenshot of ${pageUrl} was taken but not stored`);
          }

          const saved = `screenshot of ${pageUrl} saved as artifact ${key}`;
          const seesImages = await callAcceptsImages(api, context);
          if (!seesImages) return text(`${saved} (this model cannot see images)`);
          return renderFile(
            { bytes: png, name, mimeType: "image/png", kind: "image", header: saved },
            { convert: undefined, acceptsImages: () => Promise.resolve(seesImages) },
          );
        }

        if (input.action === "open") {
          const host = hostOf(input.url!);
          if (host === null) return text(`only http(s) urls can be opened: ${input.url!}`, true);
          if (isBlockedHost(host)) return text(`blocked host: ${host}`, true);

          const snapshot = await deps.client.open(deps.taskId(), input.url!);
          return await checkLanding(snapshot);
        }

        const snapshot = await deps.client.act(deps.taskId(), input.action, {
          target: input.target,
          text: input.text,
          key: input.key,
        });
        return await checkLanding(snapshot);
      } catch (error) {
        return await failWithShot(input.action, error);
      }
    },
  };
}
