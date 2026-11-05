import { readCapped } from "../../src/tools/http-body";
import { withProgress } from "../../src/tools/wrap";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { isBlockedHost, httpRequestTool, safeRequestUrl } from "../../src/tools/http-request";
import type { ApprovalDecision, ApprovalGateLike, ApprovalNote } from "../../src/task/approvals";

function context(signal?: AbortSignal): Context {
  return { abortSignal: signal } as unknown as Context;
}

function textOf(result: ToolExecutionResult): string {
  return (result.output ?? [])
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("");
}

function gate(decision: ApprovalDecision) {
  const seen: unknown[] = [];
  const notes: (ApprovalNote | undefined)[] = [];
  const g: ApprovalGateLike = {
    async request(_tool, args, _signal, note) {
      seen.push(args);
      notes.push(note);
      return decision;
    },
    async resolve() {
      return { ok: true, message: "" };
    },
  };
  return { g, seen, notes };
}

describe("isBlockedHost", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "localhost",
    "printer.local",
    "db.internal",
  ])("blocks %s", (host) => {
    expect(isBlockedHost(host)).toBe(true);
  });

  it.each(["example.com", "203.0.113.9", "mcp.context7.com", "fcorp.example.com"])(
    "allows %s",
    (host) => {
      expect(isBlockedHost(host)).toBe(false);
    },
  );
});

describe("httpRequestTool", () => {
  it("sends a GET without asking for approval", async () => {
    const { g, seen } = gate("approved");
    const fakeFetch = (async () => new Response("hello", { status: 200 })) as unknown as typeof fetch;
    const tool = httpRequestTool(g, fakeFetch);

    const result = await tool.execute({ url: "https://example.com/x" }, {} as never, context());

    expect(seen.length).toBe(0);
    expect(textOf(result)).toContain("200");
    expect(textOf(result)).toContain("hello");
  });

  it("asks for approval on POST and sends after it is granted", async () => {
    const { g, seen, notes } = gate("approved");
    let sent = 0;
    const fakeFetch = (async () => {
      sent += 1;
      return new Response("ok", { status: 201 });
    }) as unknown as typeof fetch;
    const tool = httpRequestTool(g, fakeFetch);

    await tool.execute(
      {
        url: "https://api.example.com/items",
        method: "POST",
        headers: { Authorization: "Bearer secret-token" },
        body: '{"a":1}',
      },
      {} as never,
      context(),
    );

    expect(seen.length).toBe(1);
    expect(notes).toEqual([{ description: tool.description }]);
    expect(JSON.stringify(seen[0])).not.toContain("secret-token");
    expect(sent).toBe(1);
  });

  it("describes writes as reviewed, with only risky ones waiting", () => {
    const tool = httpRequestTool(gate("approved").g);

    expect(tool.description).toContain("risky");
    expect(tool.description).not.toContain("asks the owner first");
  });

  it("does not send when the approval is rejected", async () => {
    const { g } = gate("rejected");
    let sent = 0;
    const fakeFetch = (async () => {
      sent += 1;
      return new Response("ok");
    }) as unknown as typeof fetch;
    const tool = httpRequestTool(g, fakeFetch);

    const result = await tool.execute(
      { url: "https://api.example.com/x", method: "DELETE" },
      {} as never,
      context(),
    );

    expect(sent).toBe(0);
    expect(textOf(result)).toContain("用户拒绝了此操作");
  });

  it("refuses private hosts before any request", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response("");
    }) as unknown as typeof fetch;
    const tool = httpRequestTool(gate("approved").g, fakeFetch);

    const result = await tool.execute(
      { url: "http://169.254.169.254/latest/meta-data/" },
      {} as never,
      context(),
    );

    expect(called).toBe(false);
    expect(textOf(result)).toContain("拒绝访问内网地址");
  });

  it("returns a redirect instead of following it", async () => {
    const fakeFetch = ((_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return Promise.resolve(
        new Response("", { status: 302, headers: { Location: "/login" } }),
      );
    }) as unknown as typeof fetch;
    const tool = httpRequestTool(gate("approved").g, fakeFetch);

    const result = await tool.execute({ url: "https://example.com/x" }, {} as never, context());

    expect(textOf(result)).toContain("302");
    expect(textOf(result)).toContain("/login");
  });

  it("rejects a body over 256 KB before sending", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response("");
    }) as unknown as typeof fetch;
    const tool = httpRequestTool(gate("approved").g, fakeFetch);

    const result = await tool.execute(
      { url: "https://example.com", method: "POST", body: "x".repeat(262_145) },
      {} as never,
      context(),
    );

    expect(called).toBe(false);
    expect(textOf(result)).toContain("请求体超过 256 KB");
  });

  it("rejects a non-http scheme", async () => {
    const tool = httpRequestTool(gate("approved").g, (async () => new Response("")) as unknown as typeof fetch);
    const result = await tool.execute({ url: "file:///etc/passwd" }, {} as never, context());
    expect(textOf(result)).toContain("仅支持 http(s) 链接");
  });

  it("returns structured output for scripts", () => {
    const tool = httpRequestTool(gate("approved").g, (async () => new Response("")) as unknown as typeof fetch);
    expect(tool.structuredOutputSchema).toBeDefined();
    expect(tool.replay).toBe("unsafe");
  });
});
it.each(["127.1", "0x7f000001", "2130706433", "localhost.", "printer.local.", "[::ffff:127.0.0.1]", "[::ffff:10.0.0.1]", "[febf::1]", "[fc00::1]"])("blocks normalized host %s", async host => {
  const fetcher=vi.fn(async()=>new Response("unexpected"));
  const result=await httpRequestTool(gate("approved").g,fetcher as typeof fetch).execute({url:`http://${host}/`},{} as never,context());
  expect(result.isError).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([204,205,304])("returns an empty body for status %s",async status=>{
  const tool=httpRequestTool(gate("approved").g,(async()=>new Response(null,{status})) as typeof fetch);
  const result=await tool.execute({url:"https://example.com"},{} as never,context());
  expect(result.structuredOutput).toMatchObject({status,body:"",truncated:false});
});
it("keeps HTTP failures as structured responses",async()=>{
  const result=await httpRequestTool(gate("approved").g,(async()=>new Response("bad",{status:503,headers:{"content-type":"text/plain"}})) as typeof fetch).execute({url:"https://example.com"},{} as never,context());
  expect(result.isError).not.toBe(true);
  expect(result.structuredOutput).toMatchObject({status:503,body:"bad",bodyBase64:false});
});
it("preserves binary bytes as base64",async()=>{
  const bytes=new Uint8Array([0,255,254,128,1]);
  const result=await httpRequestTool(gate("approved").g,(async()=>new Response(bytes,{headers:{"content-type":"image/png"}})) as typeof fetch).execute({url:"https://example.com"},{} as never,context());
  expect(result.structuredOutput).toMatchObject({body:"AP/+gAE=",bodyBase64:true});
});
it("caps redirects at 2 MB and gives scripts the retained body",async()=>{
  let cancelled=false;
  const stream=new ReadableStream<Uint8Array>({pull(c){c.enqueue(new Uint8Array(512*1024).fill(97));},cancel(){cancelled=true;}});
  const result=await httpRequestTool(gate("approved").g,(async()=>new Response(stream,{status:302,headers:{Location:"/login","content-type":"text/plain","Set-Cookie":"secret"}})) as typeof fetch).execute({url:"https://example.com"},{} as never,context());
  expect(cancelled).toBe(true);
  expect(result.structuredOutput).toMatchObject({status:302,headers:{location:"/login"},truncated:true});
  expect((result.structuredOutput as {body:string}).body.length).toBe(1_000_000);
  expect((result.structuredOutput as {headers:object}).headers).not.toHaveProperty("set-cookie");
  expect(textOf(result).length).toBeLessThan(20_200);
});
it.each(["GET","HEAD"] as const)("rejects %s bodies before sending",async method=>{
  const fetcher=vi.fn(async()=>new Response(null));
  const result=await httpRequestTool(gate("approved").g,fetcher as typeof fetch).execute({url:"https://example.com",method,body:"x"},{} as never,context());
  expect(result.isError).toBe(true);expect(fetcher).not.toHaveBeenCalled();
});
it("limits request bodies by UTF-8 bytes before asking approval",async()=>{
  const {g,seen}=gate("approved");const fetcher=vi.fn(async()=>new Response(""));
  const result=await httpRequestTool(g,fetcher as typeof fetch).execute({url:"https://example.com",method:"POST",body:"中".repeat(90_000)},{} as never,context());
  expect(textOf(result)).toContain("请求体超过 256 KB");expect(seen).toHaveLength(0);expect(fetcher).not.toHaveBeenCalled();
});
it("passes approved arguments intact while redacting approval and progress summaries",async()=>{
  const {g,seen}=gate("approved"); const progress:unknown[]=[]; let sent:RequestInit|undefined;
  const tool=withProgress(httpRequestTool(g,(async(_url,init)=>{sent=init;return new Response("ok");}) as typeof fetch),async event=>{progress.push(event);},args=>`${args.method} ${safeRequestUrl(args.url)}`);
  await tool.execute({url:"https://example.com/x?api_key=query-secret#fragment-secret",method:"POST",headers:{Authorization:"header-secret","Content-Type":"application/json"},body:'{"password":"body-secret"}'},{} as never,context());
  expect(sent).toMatchObject({method:"POST",headers:{Authorization:"header-secret"},body:'{"password":"body-secret"}',redirect:"manual"});
  const serialized=JSON.stringify({seen,progress});
  for(const secret of ["query-secret","fragment-secret","header-secret","body-secret"]) expect(serialized).not.toContain(secret);
});
it("never sends expired approvals",async()=>{
  const fetcher=vi.fn(async()=>new Response(""));
  const result=await httpRequestTool(gate("expired").g,fetcher as typeof fetch).execute({url:"https://example.com",method:"POST"},{} as never,context());
  expect(result.isError).toBe(true);expect(fetcher).not.toHaveBeenCalled();
});
it("cancels after approval before sending",async()=>{
  const controller=new AbortController();const {g}=gate("approved");g.request=async()=>{controller.abort();return "approved";};
  const fetcher=vi.fn(async()=>new Response(""));
  await expect(httpRequestTool(g,fetcher as typeof fetch).execute({url:"https://example.com",method:"POST"},{} as never,context(controller.signal))).rejects.toMatchObject({name:"AbortError"});
  expect(fetcher).not.toHaveBeenCalled();
});
it("aborts a stalled body and cancels its reader",async()=>{
  const controller=new AbortController();let cancelled=false;
  const stream=new ReadableStream<Uint8Array>({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}});
  const tool=httpRequestTool(gate("approved").g,(async()=>new Response(stream)) as typeof fetch);
  const promise=tool.execute({url:"https://example.com"},{} as never,context(controller.signal));
  setTimeout(()=>controller.abort(),5);
  await expect(promise).rejects.toMatchObject({name:"AbortError"});expect(cancelled).toBe(true);
});
it.each(["fetch","body"])("reports a %s timeout with fixed wording",async phase=>{
  const controller=new AbortController();const spy=vi.spyOn(AbortSignal,"timeout").mockReturnValue(controller.signal);
  const fetcher=(async()=> phase==="fetch" ? new Promise<Response>(()=>{}) : new Response(new ReadableStream({pull(){return new Promise(()=>{});}}))) as typeof fetch;
  try {
    const pending=httpRequestTool(gate("approved").g,fetcher).execute({url:"https://example.com"},{} as never,context());
    setTimeout(()=>controller.abort(new DOMException("timed out","TimeoutError")),5);
    expect(textOf(await pending)).toBe("请求超时：超过 30 秒");
  } finally {spy.mockRestore();}
});
it.each(["fetch","body"])("reports %s failures as errors",async phase=>{
  const fetcher=(async()=>{if(phase==="fetch") throw new Error("connection failed");return new Response(new ReadableStream({start(c){c.error(new Error("body failed"));}}));}) as typeof fetch;
  const result=await httpRequestTool(gate("approved").g,fetcher).execute({url:"https://example.com"},{} as never,context());
  expect(result.isError).toBe(true);expect(textOf(result)).toContain("请求失败");
});

it("dares not rebuild a body for a null-body status", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; } });
  // workerd refuses to construct such a Response, but a proxy or transport can still hand one over.
  const capped = await readCapped({ status: 205, headers: new Headers(), body: stream } as Response);
  expect(capped.truncated).toBe(false);
  expect(capped.response.body).toBe(null);
  expect(cancelled).toBe(false);
});

it("bounds the body a script receives so a nested result stays storable", async () => {
  const chunk = new Uint8Array(256 * 1024).fill(97);
  let read = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      read += chunk.byteLength;
      if (read > 4 * 1024 * 1024) controller.close();
      else controller.enqueue(chunk);
    },
  });
  const result = await httpRequestTool(
    gate("approved").g,
    (async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as typeof fetch,
  ).execute({ url: "https://example.com/big" }, {} as never, context());

  const structured = result.structuredOutput as { body: string; truncated: boolean };
  expect(structured.body.length).toBe(1_000_000);
  expect(structured.truncated).toBe(true);
});

it("succeeds on HEAD without a body", async () => {
  const result = await httpRequestTool(
    gate("approved").g,
    (async () =>
      new Response(null, {
        status: 200,
        headers: { "content-type": "text/html", "content-length": "1234" },
      })) as typeof fetch,
  ).execute({ url: "https://example.com/x", method: "HEAD" }, {} as never, context());

  expect(result.isError).not.toBe(true);
  expect(result.structuredOutput).toMatchObject({ status: 200, body: "" });
});
