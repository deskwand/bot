import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { webFetchTool } from "../../src/tools/web-fetch";
import { PNG_B64, bytes, fakeApi } from "../helpers/images";

function context(signal?: AbortSignal): Context {
  return { abortSignal: signal } as unknown as Context;
}

function textOf(result: ToolExecutionResult): string {
  return (result.output ?? [])
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("");
}

describe("webFetchTool", () => {
  it("rejects non-http(s) URLs without making a request", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response("should not happen");
    }) as typeof fetch;

    const tool = webFetchTool(fakeFetch);
    const result = await tool.execute(
      { url: "file:///etc/passwd" },
      {} as never,
      context(),
    );

    expect(called).toBe(false);
    expect(textOf(result)).toContain("http(s)");
  });

  it("strips script, style, nav and footer content from HTML", async () => {
    const html = `<!doctype html>
      <html>
        <head><title>Page title</title><style>.hidden { color: red }</style></head>
        <body>
          <nav>navigation menu</nav>
          <h1>Hello</h1>
          <script>alert("secret script")</script>
          <p>World</p>
          <footer>footer text</footer>
        </body>
      </html>`;

    const fakeFetch = (async () =>
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as typeof fetch;

    const tool = webFetchTool(fakeFetch);
    const result = await tool.execute(
      { url: "https://example.test/page" },
      {} as never,
      context(),
    );
    const text = textOf(result);

    expect(text).toContain("Hello");
    expect(text).toContain("World");
    expect(text).not.toContain("secret script");
    expect(text).not.toContain("navigation menu");
    expect(text).not.toContain("footer text");
    expect(text).not.toContain("color: red");
    expect(tool.replay).toBe("safe");
  });

  it("returns JSON and plain text bodies", async () => {
    const jsonFetch = (async () =>
      new Response(JSON.stringify({ answer: 42 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const textFetch = (async () =>
      new Response("plain body", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as typeof fetch;

    const json = await webFetchTool(jsonFetch).execute(
      { url: "https://example.test/data" },
      {} as never,
      context(),
    );
    const text = await webFetchTool(textFetch).execute(
      { url: "https://example.test/text" },
      {} as never,
      context(),
    );

    expect(textOf(json)).toBe('{"answer":42}');
    expect(textOf(text)).toBe("plain body");
  });

  it("reports unsupported content types", async () => {
    const fakeFetch = (async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "application/zip" },
      })) as typeof fetch;

    const result = await webFetchTool(fakeFetch).execute(
      { url: "https://example.test/archive.zip" },
      {} as never,
      context(),
    );

    expect(textOf(result)).toContain("application/zip");
  });

  it("converts a PDF response to markdown", async () => {
    const fakeFetch = (async () =>
      new Response(new TextEncoder().encode("%PDF-1.4 x"), {
        headers: { "content-type": "application/pdf" },
      })) as typeof fetch;
    const result = await webFetchTool(fakeFetch, async () => ({
      ok: true,
      markdown: "# 论文",
    })).execute({ url: "https://example.test/p.pdf" }, {} as never, context());
    expect(textOf(result)).toContain("# 论文");
  });

  it("points a truncated document to save_artifact", async () => {
    const big = new Uint8Array(3 * 1024 * 1024);
    big.set(new TextEncoder().encode("%PDF-"));
    const fakeFetch = (async () =>
      new Response(big, {
        headers: { "content-type": "application/pdf" },
      })) as typeof fetch;
    let called = false;
    const result = await webFetchTool(fakeFetch, async () => {
      called = true;
      return { ok: true, markdown: "" };
    }).execute({ url: "https://example.test/big.pdf" }, {} as never, context());
    expect(called).toBe(false);
    expect(textOf(result)).toContain("save_artifact");
  });

  it("labels the output with the sniffed type, not octet-stream", async () => {
    const fakeFetch = (async () =>
      new Response(new TextEncoder().encode("%PDF-1.4 x"), {
        headers: { "content-type": "application/octet-stream" },
      })) as typeof fetch;
    const result = await webFetchTool(fakeFetch, async () => ({
      ok: true,
      markdown: "# 论文",
    })).execute({ url: "https://example.test/p" }, {} as never, context());
    const text = textOf(result);
    expect(text).toContain("application/pdf ·");
    expect(text).not.toContain("application/octet-stream");
  });

  it("returns an image response as an image", async () => {    const fakeFetch = (async () =>
      new Response(bytes(PNG_B64), {
        headers: { "content-type": "image/png" },
      })) as typeof fetch;
    const result = await webFetchTool(fakeFetch).execute(
      { url: "https://example.test/a.png" },
      fakeApi(true),
      context(),
    );
    expect(result.output?.some((item) => item.type === "image")).toBe(true);
  });

  it("truncates long content to 20000 characters and marks it", async () => {
    const fakeFetch = (async () =>
      new Response("a".repeat(25_000), {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as typeof fetch;

    const result = await webFetchTool(fakeFetch).execute(
      { url: "https://example.test/long" },
      {} as never,
      context(),
    );
    const text = textOf(result);

    expect(text).toContain("已截断");
    expect(text.startsWith("a".repeat(20_000))).toBe(true);
    expect(text.length).toBeLessThan(20_000 + 50);
  });

  it("stops reading a large body after 2 MB and notes truncation", async () => {
    const chunk = new Uint8Array(512 * 1024).fill(97);
    let pulled = 0;
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 10) {
          controller.close();
          return;
        }
        sent += 1;
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const fakeFetch = (async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as typeof fetch;

    const result = await webFetchTool(fakeFetch).execute(
      { url: "https://example.test/big" },
      {} as never,
      context(),
    );
    const text = textOf(result);

    expect(pulled).toBeLessThan(4 * 1024 * 1024);
    expect(text).toContain("已截断");
    expect(text.startsWith("a".repeat(20_000))).toBe(true);
  });

  it("rethrows a caller abort, even if fetch never settles", async () => {
    const fakeFetch = (() => new Promise<Response>(() => {})) as typeof fetch;
    const controller = new AbortController();
    const tool = webFetchTool(fakeFetch);

    const started = Date.now();
    setTimeout(() => controller.abort(), 10);

    const promise = tool.execute(
      { url: "https://example.test/hang" },
      {} as never,
      context(controller.signal),
    );

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("reports the tool timeout as a timeout message", async () => {
    const timeout = AbortSignal.abort(
      new DOMException("timed out", "TimeoutError"),
    );
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeout);

    try {
      const fakeFetch = (() => new Promise<Response>(() => {})) as typeof fetch;
      const result = await webFetchTool(fakeFetch).execute(
        { url: "https://example.test/slow" },
        {} as never,
        context(),
      );

      expect(textOf(result)).toContain("超时");
      expect(textOf(result)).not.toContain("已取消");
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
