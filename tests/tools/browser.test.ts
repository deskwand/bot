import type { Context } from "@earendil-works/chord/context";
import { describe, expect, it, vi } from "vitest";
import { PNG_B64, bytes, fakeApi } from "../helpers/images";
import { browseTool, hostOf, renderSnapshot } from "../../src/tools/browser";
import type { BrowserClient, Snapshot } from "../../src/sandbox/browser-http";
import { browserExtension, browserSectionText } from "../../src/sandbox/browser-install";

const context = (): Context => ({}) as unknown as Context;

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    url: "https://a.example/login",
    title: "Login",
    text: "Welcome",
    elements: [
      { ref: "e1", role: "textbox", name: "Email", type: "email", placeholder: "Email" },
      { ref: "e2", role: "button", name: "Sign in" },
    ],
    truncated: { text: false, elements: false, filtered: 0 },
    ...over,
  };
}

function stubClient(over: Partial<BrowserClient> = {}) {
  const calls: string[] = [];
  const probes: string[] = [];
  const client: BrowserClient = {
    features: async () => {
      probes.push("features");
      return ["browser"];
    },
    open: async (session, url) => {
      calls.push(`open ${session} ${url}`);
      return snapshot();
    },
    act: async (session, action, args) => {
      calls.push(
        `act ${session} ${action} ${args?.target ?? ""} ${args?.text ?? ""} ${args?.key ?? ""}`,
      );
      return snapshot();
    },
    upload: async (session, target, path) => {
      calls.push(`upload ${session} ${target} ${path}`);
      return snapshot();
    },
    download: async (session, target, timeoutMs) => {
      calls.push(`download ${session} ${target} ${String(timeoutMs)}`);
      throw new Error("not stubbed in this test");
    },
    shot: async (session, fullPage) => {
      calls.push(`shot ${session} ${String(fullPage)}`);
      return new Uint8Array([1]);
    },
    close: async (session) => {
      calls.push(`close ${session}`);
    },
    openMirror: async (url) => ({ url: url ?? "", title: "", viewport: { width: 1280, height: 800 } }),
    mirrorStream: async () => new Response("", { headers: { "content-type": "text/event-stream" } }),
    mirrorInput: async () => ({ ok: true }),
    closeMirror: async () => {},
    ...over,
  };
  return { client, calls, probes };
}

const bucket = { put: async () => {}, get: async () => null } as never;

function textOf(result: { output?: { type: string; text?: string }[] }): string {
  return (result.output ?? []).map((item) => (item.type === "text" ? (item.text ?? "") : "")).join("");
}

describe("renderSnapshot", () => {
  it("prints the url, the text and the numbered elements", () => {
    const text = renderSnapshot(snapshot());
    expect(text).toContain("URL: https://a.example/login");
    expect(text).toContain("Welcome");
    expect(text).toContain('e1 textbox "Email" type=email placeholder=Email');
    expect(text).toContain('e2 button "Sign in"');
  });

  it("mentions the CSS escape hatch when elements were not listed", () => {
    const text = renderSnapshot(snapshot({ truncated: { text: false, elements: true, filtered: 3 } }));
    expect(text).toContain("CSS selector");
  });

  it("mentions it when nothing was listed at all", () => {
    expect(renderSnapshot(snapshot({ elements: [] }))).toContain("CSS selector");
  });
});

describe("hostOf", () => {
  it("returns the hostname for http(s) only", () => {
    expect(hostOf("https://a.example/x")).toBe("a.example");
    expect(hostOf("ftp://a.example/x")).toBeNull();
    expect(hostOf("not a url")).toBeNull();
  });
});

describe("browseTool", () => {
  it("rejects open without a url", async () => {
    const { client } = stubClient();
    const tool = browseTool({ client, taskId: () => "task-1", bucket, files: null });
    const result = await tool.execute({ action: "open" } as never, {} as never, context());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("url");
  });

  it("refuses a private host without calling the sandbox", async () => {
    const { client, calls } = stubClient();
    const tool = browseTool({ client, taskId: () => "task-1", bucket, files: null });
    const result = await tool.execute(
      { action: "open", url: "http://127.0.0.1:8080/x" } as never,
      {} as never,
      context(),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("blocked host");
    expect(calls).toEqual([]);
  });

  it("passes the task id as the session and renders the page", async () => {
    const { client, calls } = stubClient();
    const tool = browseTool({ client, taskId: () => "task-1", bucket, files: null });
    const result = await tool.execute(
      { action: "open", url: "https://a.example/login" } as never,
      {} as never,
      context(),
    );
    expect(calls).toEqual(["open task-1 https://a.example/login"]);
    expect(textOf(result)).toContain('e1 textbox "Email" type=email');
  });

  it("clicks by ref and forwards the text of a fill", async () => {
    const { client, calls } = stubClient();
    const tool = browseTool({ client, taskId: () => "task-1", bucket, files: null });
    await tool.execute(
      { action: "open", url: "https://a.example/login" } as never,
      {} as never,
      context(),
    );
    await tool.execute(
      { action: "fill", target: "e1", text: "me@example.com" } as never,
      {} as never,
      context(),
    );
    expect(calls[1]).toBe("act task-1 fill e1 me@example.com ");
  });

  it("reports a stale ref as an error the model can act on", async () => {
    const { client } = stubClient({
      act: async () => {
        throw new Error("page moved — read it again");
      },
    });
    const tool = browseTool({ client, taskId: () => "task-1", bucket, files: null });
    await tool.execute({ action: "open", url: "https://a.example" } as never, {} as never, context());
    const result = await tool.execute({ action: "click", target: "e9" } as never, {} as never, context());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("page moved");
  });

  it("closes the tab when an action lands on a blocked host", async () => {
    const { client, calls } = stubClient({
      act: async () => snapshot({ url: "http://169.254.169.254/latest/meta-data" }),
    });
    const tool = browseTool({ client, taskId: () => "task-1", bucket, files: null });
    await tool.execute({ action: "open", url: "https://a.example" } as never, {} as never, context());
    const result = await tool.execute({ action: "click", target: "e2" } as never, {} as never, context());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("blocked host");
    expect(calls).toContain("close task-1");
  });

  it("refuses a landing on a non-http page", async () => {
    const { client, calls } = stubClient({
      act: async () => snapshot({ url: "file:///etc/passwd" }),
    });
    const tool = browseTool({ client, taskId: () => "task-1", bucket, files: null });
    await tool.execute({ action: "open", url: "https://a.example" } as never, {} as never, context());
    const result = await tool.execute({ action: "click", target: "e2" } as never, {} as never, context());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("non-http");
    expect(calls).toContain("close task-1");
  });

  it("says the task has not started rather than opening a blank session", async () => {
    const { client } = stubClient();
    const tool = browseTool({ client, taskId: () => "", bucket, files: null });
    const result = await tool.execute({ action: "read" } as never, {} as never, context());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("task has not started");
  });

  it("disables itself when the image has no browser, after one probe", async () => {
    const probes: string[] = [];
    const { client, calls } = stubClient({
      features: async () => {
        probes.push("features");
        return [];
      },
    });
    const tool = browseTool({ client, taskId: () => "task-1", bucket, files: null });
    const first = await tool.execute({ action: "read" } as never, {} as never, context());
    expect(textOf(first)).toContain("upgrade the sandbox image");
    const second = await tool.execute({ action: "read" } as never, {} as never, context());
    expect(textOf(second)).toContain("upgrade the sandbox image");
    expect(calls).toEqual([]);
    expect(probes).toHaveLength(1);
  });

  it("says the sandbox is down instead of blaming the image", async () => {
    const { client } = stubClient({
      features: async () => {
        throw new Error("sandbox is not reachable");
      },
    });
    const tool = browseTool({ client, taskId: () => "task-1", bucket, files: null });
    const result = await tool.execute({ action: "read" } as never, {} as never, context());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not reachable");
    expect(textOf(result)).not.toContain("upgrade");
  });
});

describe("browseTool shot", () => {
  it("stores the screenshot as an artifact and reports the key", async () => {
    const png = bytes(PNG_B64);
    const { client, calls } = stubClient({ shot: async () => png });
    const put = vi.fn(async () => {});
    const tool = browseTool({ client, taskId: () => "task-1", bucket: { put } as never, files: null });
    const result = await tool.execute({ action: "shot" } as never, fakeApi(false), context());
    // The shot path reads the page first so it can name the file after it.
    expect(calls.some((call) => call.startsWith("act task-1 read"))).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
    expect(textOf(result)).toContain("artifact");
    expect(result.output?.some((item) => item.type === "image")).toBe(false);
  });

  it("includes the image when the model takes images", async () => {
    const png = bytes(PNG_B64);
    const { client } = stubClient({ shot: async () => png });
    const tool = browseTool({ client, taskId: () => "task-1", bucket: { put: async () => {} } as never, files: null });
    const result = await tool.execute({ action: "shot" } as never, fakeApi(true), context());
    expect(result.output?.some((item) => item.type === "image")).toBe(true);
  });

  it("still reports the page when the artifact write fails", async () => {
    const { client } = stubClient({ shot: async () => bytes(PNG_B64) });
    const tool = browseTool({
      client,
      taskId: () => "task-1",
      bucket: {
        put: async () => {
          throw new Error("r2 is down");
        },
      } as never,
      files: null,
    });
    const result = await tool.execute({ action: "shot" } as never, fakeApi(true), context());
    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain("screenshot");
  });

  it("numbers screenshots so two shots do not collide", async () => {
    const names: string[] = [];
    const { client } = stubClient({ shot: async () => bytes(PNG_B64) });
    const tool = browseTool({
      client,
      taskId: () => "task-1",
      bucket: {
        put: async (key: string) => {
          names.push(key);
        },
      } as never,
      files: null,
    });
    await tool.execute({ action: "shot" } as never, fakeApi(false), context());
    await tool.execute({ action: "shot", fullPage: true } as never, fakeApi(false), context());
    expect(names[0]).toContain("browse-1.png");
    expect(names[1]).toContain("browse-2.png");
  });
});

// `artifactStore` throws when neither R2 binding exists, even though the
// extension only needs it once a screenshot is taken.
const BROWSER_ENV = { SANDBOX_URL: "http://sandbox:8080", SANDBOX_TOKEN: "t", ARTIFACTS: {} };

describe("browserExtension", () => {
  it("mounts one browse tool when the sandbox is configured", () => {
    const extension = browserExtension(BROWSER_ENV as never, { taskId: () => "task-1" });
    expect(extension?.name).toBe("browser");
    expect(extension?.tools?.map((tool) => tool.name)).toEqual(["browse"]);
  });

  it("is absent without a sandbox", () => {
    expect(browserExtension({} as never, { taskId: () => "task-1" })).toBeNull();
  });

  it("says what the model must know before using it", () => {
    const text = browserSectionText();
    expect(text).toContain("browse");
    expect(text).toContain("read it again");
    expect(text).toContain("At most 3 per task");
  });
});

describe("automatic screenshot on failure", () => {
  // A real PNG: renderFile re-encodes through Photon, so a stub byte array would
  // take the "image cannot be processed" branch instead of the one under test.
  const failing = (message: string) => {
    let shots = 0;
    const { client } = stubClient({
      act: async () => {
        throw new Error(message);
      },
      shot: async () => {
        shots += 1;
        return bytes(PNG_B64);
      },
    });
    return { client, shots: () => shots };
  };

  async function run(
    vision: boolean,
    client: BrowserClient,
    action: "click" | "read" = "click",
  ) {
    const tool = browseTool({ client, taskId: () => "t1", bucket, files: null });
    const call = tool.execute as unknown as (
      args: unknown,
      api: unknown,
      context: unknown,
    ) => Promise<{ output?: { type: string; text?: string }[]; isError?: boolean }>;
    return call({ action, target: "e1" }, fakeApi(vision), context());
  }

  it("attaches an image to a click failure for a model that can see it", async () => {
    const result = await run(true, failing("page moved — read it again").client);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("page moved — read it again");
    expect(textOf(result)).toContain("a screenshot of the page is attached");
    expect(JSON.stringify(result.output)).toContain("image");
  });

  it("does not attach an image to a model that cannot see one", async () => {
    const result = await run(false, failing("page moved — read it again").client);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("page moved — read it again");
  });

  it("does not attach an image to a read failure", async () => {
    const result = await run(true, failing("no such session").client, "read");
    expect(textOf(result)).toBe("no such session");
  });

  it("attaches at most one image per distinct error message", async () => {
    const { client, shots } = failing("stale");
    const tool = browseTool({ client, taskId: () => "t1", bucket, files: null });
    const call = tool.execute as unknown as (
      args: unknown,
      api: unknown,
      context: unknown,
    ) => Promise<{ output?: { type: string; text?: string }[] }>;
    await call({ action: "click", target: "e1" }, fakeApi(true), context());
    await call({ action: "click", target: "e1" }, fakeApi(true), context());
    expect(shots()).toBe(1);
  });
});

describe("upload action", () => {
  const artifactBucket = {
    put: async () => {},
    get: async (key: string) => ({
      arrayBuffer: async () => new TextEncoder().encode(`bytes of ${key}`).buffer,
    }),
  } as never;

  function toolWith(features: string[], files: unknown = {
    writeFile: async () => {},
    readFile: async () => new Uint8Array(),
  }) {
    const { client, calls } = stubClient({ features: async () => features });
    return {
      calls,
      tool: browseTool({ client, taskId: () => "t1", bucket: artifactBucket, files: files as never }),
    };
  }

  const call = async (tool: ReturnType<typeof browseTool>, args: unknown) =>
    (tool.execute as unknown as (a: unknown, b: unknown, c: unknown) => Promise<{
      output?: { type: string; text?: string }[];
      isError?: boolean;
    }>)(args, fakeApi(true), context());

  it("refuses when the image has no upload feature", async () => {
    const { tool } = toolWith(["browser", "browser-mirror"]);
    const result = await call(tool, {
      action: "upload",
      target: "input[type=file]",
      source: "artifact:t1/9f1/a.csv",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("too old to upload");
  });

  it("writes the artifact bytes into the sandbox and returns the page", async () => {
    const { tool, calls } = toolWith(["browser", "browser-upload"]);
    const result = await call(tool, {
      action: "upload",
      target: "input[type=file]",
      source: "artifact:t1/9f1/a.csv",
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("URL: https://a.example/login");
    expect(calls.some((entry) => entry.startsWith("upload t1 input[type=file] /tmp/dw-uploads/"))).toBe(true);
  });

  it("says which file is missing instead of uploading nothing", async () => {
    const { client } = stubClient({ features: async () => ["browser", "browser-upload"] });
    const tool = browseTool({
      client,
      taskId: () => "t1",
      bucket: { put: async () => {}, get: async () => null } as never,
      files: { writeFile: async () => {}, readFile: async () => new Uint8Array() } as never,
    });
    const result = await call(tool, {
      action: "upload",
      target: "input[type=file]",
      source: "artifact:t1/9f1/gone.csv",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("no such file");
  });
});

describe("download action", () => {
  const emptySnapshot: Snapshot = {
    url: "https://a.example/dl",
    title: "T",
    text: "",
    elements: [],
    truncated: { text: false, elements: false, filtered: 0 },
  };
  const big = { name: "big.bin", size: 20 << 20, path: "/tmp/dw-downloads/x/big.bin", snapshot: emptySnapshot };
  const small = { name: "a.csv", size: 3, path: "/tmp/dw-downloads/x/a.csv", snapshot: emptySnapshot };

  function toolWith(download: unknown, features = ["browser", "browser-download"]) {
    const { client } = stubClient({ features: async () => features, download: download as never });
    return browseTool({
      client,
      taskId: () => "t1",
      bucket: { put: async () => {}, get: async () => null } as never,
      files: { writeFile: async () => {}, readFile: async () => new Uint8Array([1, 2, 3]) } as never,
    });
  }

  const call = async (tool: ReturnType<typeof browseTool>, args: unknown) =>
    (tool.execute as unknown as (a: unknown, b: unknown, c: unknown) => Promise<{
      output?: { type: string; text?: string }[];
      isError?: boolean;
    }>)(args, fakeApi(true), context());

  it("turns a small download into an artifact", async () => {
    const result = await call(toolWith(async () => small), { action: "download", target: "#get" });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("t1/");
  });

  it("refuses a truncated read instead of storing a short artifact", async () => {
    const truncated = { ...small, size: 10 }; // 说 10 字节，桩只返回 3
    const result = await call(toolWith(async () => truncated), { action: "download", target: "#get" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("the sandbox reported 10 bytes but 3 came back");
  });

  it("keeps a download whose sandbox reported no size", async () => {
    // An older sandbox omits size; the field is required in the type but the JSON
    // is not validated, so it arrives undefined.
    const unreported = { name: small.name, path: small.path, snapshot: small.snapshot };
    const result = await call(toolWith(async () => unreported), { action: "download", target: "#get" });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("t1/");
    expect(textOf(result)).toContain("(3 bytes)");
    expect(textOf(result)).not.toContain("undefined");
  });

  it("leaves a big download in the sandbox and says for how long", async () => {
    const result = await call(toolWith(async () => big), { action: "download", target: "#get" });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("/tmp/dw-downloads/x/big.bin");
    expect(textOf(result)).toContain("1 hour");
  });

  it("refuses when the image has no download feature", async () => {
    const result = await call(toolWith(async () => small, ["browser", "browser-upload"]), {
      action: "download",
      target: "#get",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("too old to download");
  });
});

describe("upload source resolution", () => {
  const files = {
    writeFile: async () => {},
    readFile: async () => new Uint8Array(),
  };

  function tool(store: unknown) {
    const { client } = stubClient({ features: async () => ["browser", "browser-upload"] });
    return browseTool({ client, taskId: () => "t1", bucket: store as never, files: files as never });
  }

  const call = async (handle: ReturnType<typeof browseTool>, source: string) =>
    (handle.execute as unknown as (a: unknown, b: unknown, c: unknown) => Promise<{
      output?: { type: string; text?: string }[];
      isError?: boolean;
    }>)({ action: "upload", target: "input[type=file]", source }, fakeApi(true), context());

  it("reads a workspace path from the task's own prefix", async () => {
    const asked: string[] = [];
    const handle = tool({
      put: async () => {},
      get: async (key: string) => {
        asked.push(key);
        return { arrayBuffer: async () => new Uint8Array([1]).buffer };
      },
    });
    const result = await call(handle, "/draft.csv");
    expect(result.isError).toBeFalsy();
    expect(asked[0]).toBe("work/t1/draft.csv");
  });

  it("refuses an artifact that belongs to another task", async () => {
    const asked: string[] = [];
    const handle = tool({
      put: async () => {},
      get: async (key: string) => {
        asked.push(key);
        return { arrayBuffer: async () => new Uint8Array([1]).buffer };
      },
    });
    const result = await call(handle, "artifact:other-task/9f1/a.csv");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("cannot upload that artifact");
    expect(asked).toHaveLength(0);
  });

  it("names both accepted forms when the source is a url", async () => {
    const handle = tool({ put: async () => {}, get: async () => null });
    const result = await call(handle, "https://example.com/a.csv");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('"artifact:<key>"');
    expect(textOf(result)).toContain("/draft.csv");
  });

  it("refuses a file over the artifact cap before writing anything", async () => {
    let writes = 0;
    const handle = tool({
      put: async () => {},
      get: async () => ({
        arrayBuffer: async () => new Uint8Array(15 * 1024 * 1024 + 1).buffer,
      }),
    });
    const tool2 = browseTool({
      client: stubClient({ features: async () => ["browser", "browser-upload"] }).client,
      taskId: () => "t1",
      bucket: {
        put: async () => {},
        get: async () => ({ arrayBuffer: async () => new Uint8Array(15 * 1024 * 1024 + 1).buffer }),
      } as never,
      files: {
        readFile: async () => new Uint8Array(),
        writeFile: async () => {
          writes += 1;
        },
      } as never,
    });
    const result = await call(tool2, "artifact:t1/9f1/big.bin");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("upload limit");
    expect(writes).toBe(0);
  });
});
