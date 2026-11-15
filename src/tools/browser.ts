import { Type } from "typebox";
import type {
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ArtifactStore } from "../artifact-store";
import type { BrowserClient, Snapshot } from "../sandbox/browser-http";
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
    ],
    {
      description:
        "open loads a url; click/fill act on an element number from the last snapshot (or a CSS selector); press sends a key; back goes through history; read re-reads the page without acting; shot saves a screenshot.",
    },
  ),
  url: Type.Optional(Type.String({ description: "Required for open. http(s) only." })),
  target: Type.Optional(
    Type.String({
      description:
        'Element number from the last snapshot, like "e4", or a CSS selector when nothing usable was listed.',
    }),
  ),
  text: Type.Optional(Type.String({ description: "Required for fill." })),
  key: Type.Optional(
    Type.String({ description: 'Required for press, like "Enter" or "Tab".' }),
  ),
  fullPage: Type.Optional(
    Type.Boolean({ description: "For shot: capture the whole scrollable page." }),
  ),
});

export type BrowseArgs = {
  action: "open" | "click" | "fill" | "press" | "back" | "read" | "shot";
  url?: string;
  target?: string;
  text?: string;
  key?: string;
  fullPage?: boolean;
};

const UNSUPPORTED =
  "sandbox image has no browser — ask the owner to upgrade the sandbox image, then stop";
const DOWN = "sandbox is not reachable — stop retrying";

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
  return null;
}

export type BrowseToolDeps = {
  client: BrowserClient;
  taskId: () => string;
  bucket: ArtifactStore;
};

export function browseTool(deps: BrowseToolDeps): ToolRegistration<typeof Browse> {
  /** Set once the sandbox reports it has no browser: never ask again this task. */
  let unsupported = false;
  let hasBrowser = false;
  let shots = 0;

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
          hasBrowser = (await deps.client.features()).includes("browser");
        } catch (error) {
          return text(error instanceof Error ? error.message : DOWN, true);
        }
        if (!hasBrowser) {
          unsupported = true;
          return text(UNSUPPORTED);
        }
      }

      try {
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
        return text(error instanceof Error ? error.message : String(error), true);
      }
    },
  };
}
