import type { Context } from "@earendil-works/chord";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  artifactKeyFromRef,
  getArtifactTool,
  safeArtifactRef,
} from "../../src/tools/get-artifact";
import { PNG_B64, bytes, fakeApi } from "../helpers/images";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const BASE = "https://example.com";

function context(): Context {
  return { abortSignal: undefined } as unknown as Context;
}

function textOf(result: ToolExecutionResult): string {
  return (result.output ?? [])
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("");
}

describe("artifactKeyFromRef", () => {
  it("turns a public URL back into its key and decodes once", () => {
    const url = `${BASE}/a/t1/abc/report%20%2520.md`;
    expect(artifactKeyFromRef(url, BASE)).toBe("t1/abc/report %20.md");
  });

  it("accepts a bare key", () => {
    expect(artifactKeyFromRef("t1/abc/report.md", BASE)).toBe("t1/abc/report.md");
  });

  it("rejects traversal", () => {
    expect(artifactKeyFromRef("t1/../../etc/passwd", BASE)).toBeNull();
    expect(artifactKeyFromRef(`${BASE}/a/t1/%2E%2E/x`, BASE)).toBeNull();
  });
});

describe("getArtifactTool", () => {
  it("tells the model it can only read this task's files", () => {
    const tool = getArtifactTool(env.ARTIFACTS, BASE, { taskId: () => "t1" });
    expect(tool.description).toContain("Only files saved by this task can be read.");
  });

  it("returns the stored bytes unchanged", async () => {
    const key = "t1/file-1/report.md";
    await env.ARTIFACTS.put(key, "# 标题\n\n正文 **粗体**", {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });

    const tool = getArtifactTool(env.ARTIFACTS, BASE, { taskId: () => "t1" });
    const text = textOf(
      await tool.execute({ ref: `${BASE}/a/t1/file-1/report.md` }, {} as never, context()),
    );

    expect(text).toContain("# 标题");
    expect(text).toContain("**粗体**");
    expect(text).toContain("text/markdown");
  });

  it("reports a missing artifact without throwing", async () => {
    const tool = getArtifactTool(env.ARTIFACTS, BASE, { taskId: () => "t1" });
    const result = await tool.execute(
      { ref: "t1/none/missing.md" },
      {} as never,
      context(),
    );
    expect(textOf(result)).toContain("没有这个产物");
  });
});
it.each([
  ["t1/id/literal%20.md", "t1/id/literal%20.md"],
  [`${BASE}/a/t1/id/中文%20%2520.md?q=x#y`, "t1/id/中文 %20.md"],
  ["https://evil.test/a/t1/id/x", null],
  [`${BASE}/?q=/a/t1/id/x`, null],
  [`${BASE}/a/t1/id/a%2fb`, null],
  [`${BASE}/a/t1/id/a%5cb`, null],
  [`${BASE}/a/t1/id/%`, null],
  ["", null], ["t1/id", null], ["file:///a/t1/id/x", null],
])("normalizes %s", (ref, expected) => {
  expect(artifactKeyFromRef(ref, BASE)).toBe(expected);
});
it("preserves the exact text body and MIME type", async () => {
  await env.ARTIFACTS.put("t1/id/exact", "# 标题\n\n**bold**\n", {httpMetadata:{contentType:"TEXT/MARKDOWN; charset=utf-8"}});
  const result = await getArtifactTool(env.ARTIFACTS, BASE, { taskId: () => "t1" }).execute({ref:"t1/id/exact"}, {} as never, context());
  expect(textOf(result).split("\n\n").slice(1).join("\n\n")).toBe("# 标题\n\n**bold**\n");
});
it("marks invalid and missing references as errors", async () => {
  for(const ref of ["../x", "t1/id/absent"]) {
    expect((await getArtifactTool(env.ARTIFACTS,BASE,{ taskId: () => "t1" }).execute({ref},{} as never,context())).isError).toBe(true);
  }
});
it("caps binary output and preserves every displayed byte", async () => {
  const data = Uint8Array.from({length:15_100},(_,i)=>i%256);
  await env.ARTIFACTS.put("t1/id/binary",data);
  const text=textOf(await getArtifactTool(env.ARTIFACTS,BASE,{ taskId: () => "t1" }).execute({ref:"t1/id/binary"},{} as never,context()));
  const base64=text.split("\n\n").at(-1)!;
  expect(base64.length).toBe(20_000);
  expect(text).toContain("已截断");
  expect(Uint8Array.from(atob(base64), c=>c.charCodeAt(0))).toEqual(data.slice(0,15_000));
});
it("cancels oversized artifact streams without materializing the full object", async () => {
  let pulled=0, cancelled=false;
  const bucket={get:async()=>({size:20*1024*1024,httpMetadata:{contentType:"text/plain"},body:new ReadableStream<Uint8Array>({
    pull(c){pulled++;c.enqueue(new Uint8Array(512*1024).fill(97));},
    cancel(){cancelled=true;},
  })})} as unknown as R2Bucket;
  const text=textOf(await getArtifactTool(bucket,BASE,{ taskId: () => "t1" }).execute({ref:"t1/id/large"},{} as never,context()));
  expect(cancelled).toBe(true);
  expect(pulled).toBeLessThan(8);
  expect(text).toContain("内容超过 2 MB");
  expect(text.length).toBeLessThan(20_200);
});

it("strips credentials and query strings from the progress label", () => {
  expect(safeArtifactRef("https://user:pw@example.com/a/t1/id/x?token=secret#f")).toBe(
    "https://example.com/a/t1/id/x",
  );
  expect(safeArtifactRef("t1/id/x")).toBe("t1/id/x");
});

it("uses the caller's label for an unparsable URL", () => {
  expect(safeArtifactRef("http://[")).toBe("[无效 URL]");
  expect(safeArtifactRef("http://[", "[invalid URL]")).toBe("[invalid URL]");
});

it("refuses another task's artifact", async () => {
  await env.ARTIFACTS.put("t2/id/secret.md", "x");
  const result = await getArtifactTool(env.ARTIFACTS, BASE, { taskId: () => "t1" })
    .execute({ ref: "t2/id/secret.md" }, {} as never, context());
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("无权读取");
});

it("converts a stored PDF over 2 MB in full", async () => {
  const pdf = new Uint8Array(3 * 1024 * 1024); pdf.set(new TextEncoder().encode("%PDF-1.7"));
  await env.ARTIFACTS.put("t1/id/big.pdf", pdf, { httpMetadata: { contentType: "application/pdf" } });
  let seen = 0;
  const result = await getArtifactTool(env.ARTIFACTS, BASE, {
    taskId: () => "t1",
    convert: async ({ blob }) => { seen = blob.size; return { ok: true, markdown: "# 年报" }; },
  }).execute({ ref: "t1/id/big.pdf" }, {} as never, context());
  expect(seen).toBe(3 * 1024 * 1024);
  expect(textOf(result)).toContain("# 年报");
});

it("returns a stored image to a vision model", async () => {
  await env.ARTIFACTS.put("t1/id/shot.png", bytes(PNG_B64), { httpMetadata: { contentType: "image/png" } });
  const result = await getArtifactTool(env.ARTIFACTS, BASE, { taskId: () => "t1" })
    .execute({ ref: "t1/id/shot.png" }, fakeApi(true), context());
  expect(result.output?.some((item) => item.type === "image")).toBe(true);
});

it("returns text/* raw even when the artifact name has a document extension", async () => {
  await env.ARTIFACTS.put("t1/id/report.pdf", "# plain text", { httpMetadata: { contentType: "text/markdown" } });
  let converted = false;
  const result = await getArtifactTool(env.ARTIFACTS, BASE, {
    taskId: () => "t1",
    convert: async () => {
      converted = true;
      return { ok: true, markdown: "# 不该出现" };
    },
  }).execute({ ref: "t1/id/report.pdf" }, {} as never, context());
  expect(converted).toBe(false);
  expect(textOf(result)).toContain("# plain text");
});

it("keeps a declared image that cannot be sniffed as binary", async () => {
  await env.ARTIFACTS.put("t1/id/fake.png", new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: "image/png" } });
  const result = await getArtifactTool(env.ARTIFACTS, BASE, { taskId: () => "t1" })
    .execute({ ref: "t1/id/fake.png" }, fakeApi(true), context());
  expect(result.output?.some((item) => item.type === "image")).toBe(false);
  expect(textOf(result)).toContain("base64");
});
