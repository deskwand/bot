import type { Context } from "@earendil-works/chord";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_ARTIFACT_BYTES } from "../../src/artifact";
import { filenameFromResponse, saveArtifactTool } from "../../src/tools/artifacts";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function context(): Context {
  return { abortSignal: undefined } as unknown as Context;
}

function textOf(result: ToolExecutionResult): string {
  return (result.output ?? [])
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("");
}

describe("saveArtifactTool", () => {
  it("stores the file and returns its key, never a URL", async () => {
    const tool = saveArtifactTool(env.ARTIFACTS, () => "t1");

    const result = await tool.execute(
      { filename: "report.md", content: "# Report" },
      {} as never,
      context(),
    );
    const text = textOf(result);
    const key = text.replace("已保存：", "");

    expect(text).toBe(`已保存：${key}`);
    expect(text).not.toContain("http");
    expect(key.split("/")).toHaveLength(3);
    expect(key.startsWith("t1/")).toBe(true);
    expect(key.endsWith("/report.md")).toBe(true);

    const object = await env.ARTIFACTS.get(key);
    expect(await object?.text()).toBe("# Report");
    expect(object?.httpMetadata?.contentType).toBe(
      "text/markdown; charset=utf-8",
    );
  });

  it("sanitizes traversal characters so the key stays three segments", async () => {
    const tool = saveArtifactTool(env.ARTIFACTS, () => "t3");

    const result = await tool.execute(
      { filename: "../x/报告 v1?.md", content: "body" },
      {} as never,
      context(),
    );
    const key = textOf(result).replace("已保存：", "");

    expect(key.split("/")).toHaveLength(3);
    expect(key.startsWith("t3/")).toBe(true);
    expect(key.endsWith("/报告_v1_.md")).toBe(true);
    expect(key).not.toContain("..");
    expect(await (await env.ARTIFACTS.get(key))?.text()).toBe("body");
  });

  it("honours a custom content type", async () => {
    const tool = saveArtifactTool(env.ARTIFACTS, () => "t2");

    const result = await tool.execute(
      { filename: "data.json", content: "{}", contentType: "application/json" },
      {} as never,
      context(),
    );
    const key = textOf(result).replace("已保存：", "");

    expect((await env.ARTIFACTS.get(key))?.httpMetadata?.contentType).toBe(
      "application/json",
    );
  });

  it("refuses content over the cap without writing anything", async () => {
    const tool = saveArtifactTool(env.ARTIFACTS, () => "t4");
    const atCap = "a".repeat(MAX_ARTIFACT_BYTES);

    const ok = await tool.execute(
      { filename: "exact.txt", content: atCap },
      {} as never,
      context(),
    );
    const exactKey = textOf(ok).replace("已保存：", "");
    expect((await env.ARTIFACTS.get(exactKey))?.size).toBe(MAX_ARTIFACT_BYTES);

    const tooBig = await tool.execute(
      { filename: "big.txt", content: `${atCap}a` },
      {} as never,
      context(),
    );
    expect(tooBig.isError).toBe(true);
    expect(textOf(tooBig)).toContain("15 MB");
    // 超限的写入必须没有发生：同一个任务前缀下只有一个对象（那就是 exactKey）。
    const listed = await env.ARTIFACTS.list({ prefix: "t4/" });
    expect(listed.objects.map((object) => object.key)).toEqual([exactKey]);
  });

  it("fails when the task has not started", async () => {
    const tool = saveArtifactTool(env.ARTIFACTS, () => "");

    await expect(
      tool.execute(
        { filename: "x.txt", content: "x" },
        {} as never,
        context(),
      ),
    ).rejects.toThrow("任务尚未开始");
  });
});

describe("saveArtifactTool binary intake", () => {
  function encode(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  it("stores decoded bytes for a base64 payload", async () => {
    const tool = saveArtifactTool(env.ARTIFACTS, () => "t-bin");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const result = await tool.execute(
      {
        filename: "chart.png",
        content: encode(png),
        contentType: "image/png",
        encoding: "base64",
      },
      {} as never,
      context(),
    );
    const key = textOf(result).replace("已保存：", "");
    const object = await env.ARTIFACTS.get(key);

    expect(new Uint8Array((await object!.arrayBuffer())!)).toEqual(png);
    expect(object?.httpMetadata?.contentType).toBe("image/png");
    expect(object?.size).toBe(png.byteLength);
  });

  it("measures the cap on decoded bytes, not on the base64 text", async () => {
    const tool = saveArtifactTool(env.ARTIFACTS, () => "t-bin-cap");
    const atCap = encode(new Uint8Array(MAX_ARTIFACT_BYTES));
    const overCap = encode(new Uint8Array(MAX_ARTIFACT_BYTES + 1));

    const ok = await tool.execute(
      { filename: "cap.bin", content: atCap, encoding: "base64" },
      {} as never,
      context(),
    );
    expect(ok.isError).toBeUndefined();

    const tooBig = await tool.execute(
      { filename: "over.bin", content: overCap, encoding: "base64" },
      {} as never,
      context(),
    );
    expect(tooBig.isError).toBe(true);
    expect(textOf(tooBig)).toContain("15 MB");
  });

  it("rejects a payload that is not valid base64", async () => {
    const tool = saveArtifactTool(env.ARTIFACTS, () => "t-bin-bad");

    const result = await tool.execute(
      { filename: "bad.png", content: "!!!not base64!!!", encoding: "base64" },
      {} as never,
      context(),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("base64");
  });
});

describe("saveArtifactTool draft intake", () => {
  it("delivers a draft file without re-sending its content", async () => {
    await env.ARTIFACTS.put("work/t-draft/report.md", "# Draft body");
    const tool = saveArtifactTool(env.ARTIFACTS, () => "t-draft");

    const result = await tool.execute(
      { draft: "report.md" },
      {} as never,
      context(),
    );
    const key = textOf(result).replace("已保存：", "");

    expect(result.isError).toBeUndefined();
    expect(key.split("/")).toHaveLength(3);
    expect(key.startsWith("t-draft/")).toBe(true);
    expect(key.endsWith("/report.md")).toBe(true);
    const object = await env.ARTIFACTS.get(key);
    expect(await object?.text()).toBe("# Draft body");
    expect(object?.httpMetadata?.contentType).toBe(
      "text/markdown; charset=utf-8",
    );
  });

  it("uses the filename override and infers a known type", async () => {
    await env.ARTIFACTS.put(
      "work/t-draft-name/raw",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const tool = saveArtifactTool(env.ARTIFACTS, () => "t-draft-name");

    const key = textOf(
      await tool.execute(
        { draft: "raw", filename: "chart.png" },
        {} as never,
        context(),
      ),
    ).replace("已保存：", "");

    expect(key.endsWith("/chart.png")).toBe(true);
    expect((await env.ARTIFACTS.get(key))?.httpMetadata?.contentType).toBe(
      "image/png",
    );
  });

  it("reports a missing draft", async () => {
    const tool = saveArtifactTool(env.ARTIFACTS, () => "t-draft");
    const result = await tool.execute(
      { draft: "missing.md" },
      {} as never,
      context(),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("草稿不存在：missing.md");
  });

  it("does not export a shared skill through private draft intake", async () => {
    await env.ARTIFACTS.put("skills/demo/SKILL.md", "shared-only");
    const tool = saveArtifactTool(env.ARTIFACTS, () => "t-skill-export");

    const result = await tool.execute(
      { draft: "/skills/demo/SKILL.md" },
      {} as never,
      context(),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("草稿不存在");
  });

  it("rejects a draft path that escapes the workspace", async () => {
    await env.ARTIFACTS.put("x.md", "outside");
    const tool = saveArtifactTool(env.ARTIFACTS, () => "t-draft");
    const result = await tool.execute(
      { draft: "../x" },
      {} as never,
      context(),
    );
    expect(result.isError).toBe(true);
  });

  it("rejects content together with draft", async () => {
    const tool = saveArtifactTool(env.ARTIFACTS, () => "t-draft");
    const result = await tool.execute(
      { filename: "a.md", content: "x", draft: "report.md" },
      {} as never,
      context(),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("content、url、draft 必须且只能给一个");
  });
});

describe("saveArtifactTool url intake", () => {
  const tool = (f: typeof fetch) => saveArtifactTool(env.ARTIFACTS, () => "t1", undefined, f);

  it("stores the downloaded bytes with the response type and disposition name", async () => {
    const f = (async () => new Response(new Uint8Array([1, 2, 3]), { headers: {
      "content-type": "application/pdf",
      "content-disposition": "attachment; filename*=UTF-8''%E5%B9%B4%E6%8A%A5.pdf",
    } })) as typeof fetch;
    const key = textOf(await tool(f).execute({ url: "https://example.test/dl?id=1" }, {} as never, context())).replace("已保存：", "");
    expect(key.endsWith("/年报.pdf")).toBe(true);
    const object = await env.ARTIFACTS.get(key);
    expect(object?.httpMetadata?.contentType).toBe("application/pdf");
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("requires exactly one of content and url", async () => {
    const f = (async () => new Response("x")) as typeof fetch;
    expect((await tool(f).execute({ filename: "a" }, {} as never, context())).isError).toBe(true);
    expect((await tool(f).execute({ filename: "a", content: "x", url: "https://e.test/" }, {} as never, context())).isError).toBe(true);
  });

  it("refuses a private address", async () => {
    const result = await tool((async () => { throw new Error("must not fetch"); }) as typeof fetch)
      .execute({ url: "http://127.0.0.1/x" }, {} as never, context());
    expect(result.isError).toBe(true);
  });

  it("refuses a redirect into a private address", async () => {
    const f = (async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } })) as typeof fetch;
    const before = (await env.ARTIFACTS.list({ prefix: "t1/" })).objects.length;
    const result = await tool(f).execute({ url: "https://example.test/x" }, {} as never, context());
    expect(result.isError).toBe(true);
    expect((await env.ARTIFACTS.list({ prefix: "t1/" })).objects.length).toBe(before);
  });

  it("refuses a declared length over 15 MB without reading the body", async () => {
    let pulled = 0;
    const body = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); } });
    const f = (async () => new Response(body, { headers: { "content-length": String(MAX_ARTIFACT_BYTES + 1) } })) as typeof fetch;
    const result = await tool(f).execute({ url: "https://example.test/x" }, {} as never, context());
    expect(result.isError).toBe(true);
    expect(pulled).toBeLessThan(2);
  });

  it("aborts a chunked download past 15 MB without writing", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream({ pull(c) { c.enqueue(chunk); }, cancel() { cancelled = true; } });
    const f = (async () => new Response(body)) as typeof fetch;
    const before = (await env.ARTIFACTS.list({ prefix: "t1/" })).objects.length;
    const result = await tool(f).execute({ url: "https://example.test/x" }, {} as never, context());
    expect(result.isError).toBe(true);
    expect(cancelled).toBe(true);
    expect((await env.ARTIFACTS.list({ prefix: "t1/" })).objects.length).toBe(before);
  });

  it("sniffs a PDF delivered as octet-stream and fixes both type and extension", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7\n...");
    const f = (async () => new Response(pdf, {
      headers: { "content-type": "application/octet-stream" },
    })) as typeof fetch;
    const key = textOf(
      await tool(f).execute({ url: "https://example.test/dl?id=1" }, {} as never, context()),
    ).replace("已保存：", "");
    expect(key.endsWith(".pdf")).toBe(true);
    expect((await env.ARTIFACTS.get(key))?.httpMetadata?.contentType).toBe("application/pdf");
  });

  it("gives a sniffed image its extension and mime type", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const f = (async () => new Response(png)) as typeof fetch;
    const key = textOf(
      await tool(f).execute({ url: "https://example.test/render?id=2" }, {} as never, context()),
    ).replace("已保存：", "");
    expect(key.endsWith(".png")).toBe(true);
    expect((await env.ARTIFACTS.get(key))?.httpMetadata?.contentType).toBe("image/png");
  });

  it("falls back to the response name when filename is an empty string", async () => {
    const f = (async () => new Response(new Uint8Array([1, 2, 3]), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": "attachment; filename=\"from-header.pdf\"",
      },
    })) as typeof fetch;
    const key = textOf(
      await tool(f).execute(
        { url: "https://example.test/dl?id=1", filename: "" },
        {} as never,
        context(),
      ),
    ).replace("已保存：", "");
    expect(key.endsWith("/from-header.pdf")).toBe(true);
  });

  it("re-checks the backup lease before writing a download", async () => {
    let calls = 0;
    const guard = async () => {
      calls++;
      if (calls > 1) throw new Error("lease lost");
    };
    const f = (async () => new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "application/pdf" },
    })) as typeof fetch;
    const before = (await env.ARTIFACTS.list({ prefix: "t-guard/" })).objects.length;
    await expect(
      saveArtifactTool(env.ARTIFACTS, () => "t-guard", guard, f).execute(
        { url: "https://example.test/x.pdf" },
        {} as never,
        context(),
      ),
    ).rejects.toThrow("lease lost");
    expect((await env.ARTIFACTS.list({ prefix: "t-guard/" })).objects.length).toBe(before);
  });

  it("uses the download-specific message when a remote file is too large", async () => {
    const f = (async () => new Response(null, {
      headers: { "content-length": String(MAX_ARTIFACT_BYTES + 1) },
    })) as typeof fetch;
    const result = await tool(f).execute({ url: "https://example.test/x" }, {} as never, context());
    expect(textOf(result)).toContain("远程文件超过 15 MB，无法下载");
  });
});

describe("saveArtifactTool description", () => {
  it("points the model at get_artifact and url downloads", () => {
    const tool = saveArtifactTool(env.ARTIFACTS, () => "t1");
    expect(tool.description).toContain(
      "The returned key can be read back with get_artifact; use url for web files over 2 MB.",
    );
  });
});

it.each([
  ['attachment; filename="report.pdf"', "https://e.test/x", "report.pdf"],
  [null, "https://e.test/files/%E8%A1%A8.xlsx?x=1", "表.xlsx"],
  [null, "https://e.test/", "download"],
])("filenameFromResponse(%s, %s)", (disposition, url, expected) => {
  const headers = disposition ? { "content-disposition": disposition } : undefined;
  expect(filenameFromResponse(new Response(null, { headers }), new URL(url))).toBe(expected);
});
