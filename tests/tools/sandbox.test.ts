import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { ArtifactStore } from "../../src/artifact-store";
import { sandboxExtension } from "../../src/sandbox/install";
import { createSandboxTools } from "../../src/sandbox/tools";
import type {
  SandboxExecResult,
  SandboxProvider,
} from "../../src/sandbox/types";

function context(): Context {
  return { abortSignal: undefined } as unknown as Context;
}

function textOf(result: ToolExecutionResult): string {
  return (result.output ?? [])
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("");
}

function fakeProvider(overrides: Partial<SandboxProvider> = {}): SandboxProvider {
  const result: SandboxExecResult = {
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    pid: null,
    durationMs: 12,
    error: null,
    disk: { usedBytes: 1, limitBytes: 100 },
  };
  return {
    kind: "http",
    health: async () => ({ ok: true, protocol: 1 }),
    run: async () => result,
    readFile: async () => new Uint8Array([1, 2, 3]),
    writeFile: async () => undefined,
    ...overrides,
  };
}

type Stored = { key: string; body: Uint8Array };

function fakeBucket(initial: Record<string, Uint8Array> = {}) {
  const stored = new Map<string, Stored>();
  for (const [key, body] of Object.entries(initial)) stored.set(key, { key, body });
  const bucket = {
    head: async (key: string) =>
      stored.has(key) ? { key, size: stored.get(key)!.body.byteLength } : null,
    get: async (key: string) => {
      const entry = stored.get(key);
      if (entry === undefined) return null;
      return {
        key,
        size: entry.body.byteLength,
        uploaded: new Date(0),
        httpEtag: "etag",
        body: new Blob([entry.body]).stream(),
        arrayBuffer: async () => entry.body.buffer,
        text: async () => new TextDecoder().decode(entry.body),
      };
    },
    put: async (
      key: string,
      value: unknown,
      options?: { httpMetadata?: { contentType?: string } },
    ) => {
      stored.set(key, {
        key,
        body: new Uint8Array(value as Uint8Array),
        ...(options?.httpMetadata?.contentType === undefined
          ? {}
          : { contentType: options.httpMetadata.contentType }),
      });
    },
    delete: async () => undefined,
    list: async () => ({ objects: [], truncated: false }),
  };
  return { bucket: bucket as unknown as ArtifactStore, stored };
}

const deps = (bucket: ArtifactStore) => ({
  bucket,
  taskId: () => "task-1",
  locale: () => "zh" as const,
  timeoutMs: 600_000,
});

describe("sandbox tools", () => {
  it("reports the exit code, output and disk usage", async () => {
    const tools = createSandboxTools(fakeProvider(), deps(fakeBucket().bucket));
    const run = tools.find((tool) => tool.name === "sandbox_run")!;
    const text = textOf(
      await run.execute({ command: "echo hi" }, {} as never, context()),
    );
    expect(text).toContain("exit 0");
    expect(text).toContain("ok");
  });

  it("says the process is still running after a timeout", async () => {
    const provider = fakeProvider({
      run: async () => ({
        exitCode: null,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: true,
        pid: 4242,
        durationMs: 1000,
        error: null,
        disk: { usedBytes: 1, limitBytes: 100 },
      }),
    });
    const tools = createSandboxTools(provider, deps(fakeBucket().bucket));
    const run = tools.find((tool) => tool.name === "sandbox_run")!;
    const text = textOf(
      await run.execute({ command: "sleep 99" }, {} as never, context()),
    );
    expect(text).toContain("4242");
    expect(text).toContain("STILL RUNNING");
  });

  it("surfaces a command that could not start", async () => {
    const provider = fakeProvider({
      run: async () => ({
        exitCode: null,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        pid: null,
        durationMs: 0,
        error: "cannot start in /nope: spawn /bin/sh ENOENT",
        disk: { usedBytes: 1, limitBytes: 100 },
      }),
    });
    const tools = createSandboxTools(provider, deps(fakeBucket().bucket));
    const run = tools.find((tool) => tool.name === "sandbox_run")!;
    const text = textOf(
      await run.execute({ command: "true", cwd: "/nope" }, {} as never, context()),
    );
    expect(text).toContain("could not start");
    expect(text).toContain("/nope");
  });

  it("copies an artifact into the sandbox", async () => {
    const { bucket } = fakeBucket({
      "task-1/abc/report.csv": new Uint8Array([65, 66]),
    });
    let written: Uint8Array | null = null;
    const provider = fakeProvider({
      writeFile: async (_path, data) => {
        written = data;
      },
    });
    const tools = createSandboxTools(provider, deps(bucket));
    const put = tools.find((tool) => tool.name === "sandbox_put")!;
    await put.execute(
      { source: "task-1/abc/report.csv", to: "/sandbox/report.csv" },
      {} as never,
      context(),
    );
    expect(written).not.toBeNull();
    expect(Array.from(written!)).toEqual([65, 66]);
  });

  it("reads a draft path through the workspace prefix", async () => {
    const { bucket, stored } = fakeBucket();
    // The draft path resolves under work/<taskId>/ inside the store.
    stored.set("work/task-1/notes.txt", {
      key: "work/task-1/notes.txt",
      body: new Uint8Array([78]),
    });
    const tools = createSandboxTools(fakeProvider(), deps(bucket));
    const put = tools.find((tool) => tool.name === "sandbox_put")!;
    const text = textOf(
      await put.execute({ source: "/notes.txt", to: "/sandbox/n.txt" }, {} as never, context()),
    );
    expect(text).toContain("copied");
  });

  it("refuses a source that belongs to another task", async () => {
    const { bucket } = fakeBucket({
      "work/task-2/private.md": new Uint8Array([88]),
      "task-2/abc/report.pdf": new Uint8Array([89]),
    });
    let written: Uint8Array | null = null;
    const provider = fakeProvider({
      writeFile: async (_path, data) => {
        written = data;
      },
    });
    const tools = createSandboxTools(provider, deps(bucket));
    const put = tools.find((tool) => tool.name === "sandbox_put")!;

    for (const source of ["work/task-2/private.md", "task-2/abc/report.pdf"]) {
      const result = await put.execute(
        { source, to: "/sandbox/steal" },
        {} as never,
        context(),
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("does not belong to this task");
    }
    expect(written).toBeNull();
  });

  it("awaits the maintenance lease before writing an artifact", async () => {
    let guarded = 0;
    const tools = createSandboxTools(fakeProvider(), {
      ...deps(fakeBucket().bucket),
      guard: async () => {
        guarded += 1;
      },
    });
    const get = tools.find((tool) => tool.name === "sandbox_get")!;
    await get.execute({ path: "/sandbox/x.bin" }, {} as never, context());
    expect(guarded).toBe(1);
  });

  it("saves a sandbox file as an artifact with the usual key shape", async () => {
    const { bucket, stored } = fakeBucket();
    const tools = createSandboxTools(fakeProvider(), deps(bucket));
    const get = tools.find((tool) => tool.name === "sandbox_get")!;
    const text = textOf(
      await get.execute({ path: "/sandbox/chart.png" }, {} as never, context()),
    );
    expect(text).toMatch(/task-1\/[0-9a-f-]{36}\/chart\.png/);
    expect(stored.size).toBe(1);
  });

  it("refuses a sandbox file above the artifact limit", async () => {
    const provider = fakeProvider({
      readFile: async () => {
        throw Object.assign(new Error("TOO_LARGE"), {
          name: "SandboxError",
          code: "TOO_LARGE",
        });
      },
    });
    const tools = createSandboxTools(provider, deps(fakeBucket().bucket));
    const get = tools.find((tool) => tool.name === "sandbox_get")!;
    const result = await get.execute(
      { path: "/sandbox/big.bin" },
      {} as never,
      context(),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TOO_LARGE");
  });
});

describe("sandboxExtension", () => {
  const config = {
    schemaVersion: 1,
    owner: { telegramUserIds: [1] },
    models: {
      butler: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
      task: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
    },
    mcpServers: [],
  };

  /** One stub is enough: construction must not call the store. */
  function makeEnv(overrides: Record<string, unknown> = {}): Env {
    return {
      DESKWAND_CONFIG: config,
      ARTIFACT_STORE: { idFromName: () => "global", get: () => ({}) },
      ...overrides,
    } as unknown as Env;
  }

  const install = (value: Env) =>
    sandboxExtension(value, {
      taskId: () => "task-1",
      locale: () => "zh" as const,
    });

  it("is absent without both variables", () => {
    expect(install(makeEnv({ SANDBOX_URL: "http://sandbox:8080" }))).toBeNull();
    expect(install(makeEnv({ SANDBOX_TOKEN: "t" }))).toBeNull();
  });

  it("exposes three tools and one prompt section when configured", () => {
    const extension = install(
      makeEnv({ SANDBOX_URL: "http://sandbox:8080", SANDBOX_TOKEN: "t" }),
    );
    expect(extension).not.toBeNull();
    expect(extension?.tools?.map((tool) => tool.name)).toEqual([
      "sandbox_run",
      "sandbox_put",
      "sandbox_get",
    ]);
    expect(extension?.sections?.map((section) => section.key)).toEqual([
      "sandbox",
    ]);
  });

  it("stays absent when the config disables it", () => {
    const extension = install(
      makeEnv({
        SANDBOX_URL: "http://sandbox:8080",
        SANDBOX_TOKEN: "t",
        DESKWAND_CONFIG: { ...config, sandbox: { enabled: false } },
      }),
    );
    expect(extension).toBeNull();
  });
});
