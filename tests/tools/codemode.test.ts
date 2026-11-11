import { contentText, type ToolResultMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ButlerDO } from "../../src/butler/butler-do";
import { setChannelOverride } from "../../src/channels/override";
import { setModelOverride } from "../../src/llm/models";
import { loadMcpTools } from "../../src/tools/mcp";
import { fakeChannel } from "../helpers/fake-channel";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" { interface ProvidedEnv extends Env {} }

const ENV = env as unknown as Record<string, unknown>;
const savedEnv = new Map<string, unknown>();

/** Mutates the env seen by Durable Objects created after this call. */
function setEnv(patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (!savedEnv.has(key)) savedEnv.set(key, ENV[key]);
    ENV[key] = value;
  }
}

function restoreEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete ENV[key];
    else ENV[key] = value;
  }
  savedEnv.clear();
}

/** Pins the runtime config to reviewed mode for the tests written before the autonomous default. */
function reviewedMode(): void {
  const current = ENV.DESKWAND_CONFIG;
  const cfg = typeof current === "string" ? JSON.parse(current) : structuredClone(current);
  setEnv({ DESKWAND_CONFIG: { ...cfg, approvalMode: "reviewed" } });
}

beforeEach(() => setChannelOverride("telegram", fakeChannel().adapter));
afterEach(() => {
  setModelOverride(null);
  setChannelOverride("telegram", null);
  vi.restoreAllMocks();
  restoreEnv();
});

function task(taskId: string) { return env.TASK.get(env.TASK.idFromName(taskId)); }
type Stub = ReturnType<typeof task>;
function lastResult(context: TranscriptContext): ToolResultMessage {
  return context.messages.filter((m): m is ToolResultMessage => m.role === "toolResult").at(-1)!;
}
function text(result: ToolResultMessage) {
  return result.content.flatMap(c => c.type === "text" ? [c.text] : []).join("\n");
}
/** Keeps the owner Butler's speaker from consuming the TaskDO's scripted turns. */
async function muteSpeaker(): Promise<void> {
  const owner = env.BUTLER.get(env.BUTLER.idFromName("owner"));
  await runInDurableObject(owner, (instance) => {
    (instance as unknown as { completeSpeak: () => Promise<string> }).completeSpeak =
      async () => "";
  });
}

async function complete(stub: Stub) {
  await vi.waitFor(async () => expect(await stub.status()).toMatchObject({state:"completed"}), {timeout:10_000});
}
async function script(id: string, code: string, setup?: (stub: Stub) => Promise<void>) {
  let result: ToolResultMessage | undefined;
  setModelOverride(scriptedModel([
    {toolCalls:[{name:"codemode",args:{code}}]},
    {observe:c=>{result=lastResult(c);}, toolCalls:[{name:"finish_task",args:{summary:"script complete"}}]},
  ]));
  await muteSpeaker();
  const stub=task(id);
  if(setup) await setup(stub);
  await stub.start({taskId:id,title:id,instructions:"run script"});
  await complete(stub);
  expect(result).toBeDefined();
  return {stub,result:result!};
}
async function fixtureMcp(stub: Stub) {
  await runInDurableObject(stub,async instance=>{
    const loaded=await loadMcpTools([{name:"fixture",url:"https://fixture.test/mcp"}],{approval:instance.approvals,destructive:instance.approvals,review:instance.reviewedGate},async()=>({
      listTools:async()=>[{name:"echo",description:"Fixture echo",inputSchema:{type:"object",properties:{text:{type:"string"}},required:["text"]}}],
      callTool:async(_name,args)=>({content:[{type:"text",text:`echo:${args.text}`}]}),
    }),async()=>{});
    instance.registry.install({name:"fixture-mcp",tools:loaded.tools});
  });
}

describe("TaskDO codemode",()=>{
  it("installs scripts and search for tasks with no MCP servers",async()=>{
    const {stub,result}=await script("t-code-registry","return 7;");
    expect(result.isError).toBe(false);expect(text(result)).toContain("7");
    const names=await runInDurableObject(stub,instance=>instance.registry.snapshot().tools().map(({tool})=>tool.name));
    expect(names).toEqual(expect.arrayContaining(["codemode","tool_search"]));
  });
  it("fetches two pages concurrently through the installed tools",async()=>{
    const urls:string[]=[];
    vi.spyOn(globalThis,"fetch").mockImplementation(async input=>{
      urls.push(String(input));
      return new Response(String(input).endsWith("/a")?"page A":"page B",{headers:{"content-type":"text/plain"}});
    });
    const {result}=await script("t-code-fetch",'return await Promise.all([tools.web_fetch({url:"https://fixture.test/a"}),tools.web_fetch({url:"https://fixture.test/b"})]);');
    expect(result.isError).toBe(false);expect(text(result)).toContain("page A");expect(text(result)).toContain("page B");
    expect(urls.sort()).toEqual(["https://fixture.test/a","https://fixture.test/b"]);
  });
  it("keeps successful results when a nested tool fails",async()=>{
    const {result}=await script("t-code-partial",'const r=await Promise.allSettled([tools.now({}),tools.get_artifact({ref:"t0/id/missing"})]);return r.map(x=>x.status);');
    expect(result.isError).toBe(false);expect(text(result)).toContain("fulfilled");expect(text(result)).toContain("rejected");
  });
  it.each(["codemode","finish_task"])("refuses script calls to %s",async name=>{
    const code=name==="codemode"?'return await tools.codemode({code:"return 1"});':'return await tools.finish_task({summary:"premature"});';
    const {stub,result}=await script(`t-code-block-${name}`,code);
    expect(result.isError).toBe(true);
    const events=await env.BUTLER.get(env.BUTLER.idFromName("owner")).debugEvents(`t-code-block-${name}`);
    expect(events.find(e=>e.type==="completed")?.payload).toMatchObject({summary:"script complete"});
  });
  it("interrupts infinite computation and leaves the same DO usable",async()=>{
    let failed: ToolResultMessage|undefined, followup: ToolResultMessage|undefined;
    setModelOverride(scriptedModel([
      {toolCalls:[{name:"codemode",args:{code:"while(true) {}"}}]},
      {observe:c=>{failed=lastResult(c);},toolCalls:[{name:"now",args:{}}]},
      {observe:c=>{followup=lastResult(c);},toolCalls:[{name:"finish_task",args:{summary:"alive"}}]},
    ]));
    const stub=task("t-code-loop");await stub.start({taskId:"t-code-loop",title:"loop",instructions:"loop"});await complete(stub);
    expect(failed?.isError).toBe(true);expect(text(failed!)).toMatch(/timeout|interrupt|budget|timed out/i);
    expect(followup?.isError).toBe(false);expect(text(followup!)).toContain("UTC");
  },15_000);
  it.each(["approved","rejected"] as const)("waits for an HTTP POST approval: %s",async decision=>{
    let sent=0;vi.spyOn(globalThis,"fetch").mockImplementation(async()=>{sent++;return new Response("created",{status:201,headers:{"content-type":"text/plain"}});});
    let result:ToolResultMessage|undefined;
    setModelOverride(scriptedModel([
      {toolCalls:[{name:"codemode",args:{code:'try { const r=await tools.http_request({url:"https://fixture.test/items",method:"POST",body:"{}"});return r.status; } catch(e) { return "caught rejection"; }'}}]},
      {text:'{"verdict":"ask","reason":"测试需要确认"}'},
      {observe:c=>{result=lastResult(c);},toolCalls:[{name:"finish_task",args:{summary:"approved flow done"}}]},
    ]));
    reviewedMode();
    const id=`t-code-approval-${decision}`,stub=task(id);
    await stub.start({taskId:id,title:id,instructions:"post"});
    let approvalId="";
    await vi.waitFor(async()=>{const pending=await stub.pendingApprovals();expect(pending).toHaveLength(1);approvalId=pending[0]!.approvalId;expect(pending[0]!.reason).toBe("测试需要确认");},{timeout:10_000});
    expect(sent).toBe(0);expect(result).toBeUndefined();
    await runInDurableObject(stub,instance=>instance.approvals.resolve(approvalId,decision));
    await complete(stub);
    expect(sent).toBe(decision==="approved"?1:0);
    expect(result?.isError).toBe(false);expect(text(result!)).toContain(decision==="approved"?"201":"caught rejection");
  });
  it("runs an HTTP POST the reviewer allows",async()=>{
    let sent=0;vi.spyOn(globalThis,"fetch").mockImplementation(async()=>{sent++;return new Response("created",{status:201,headers:{"content-type":"text/plain"}});});
    const progress=vi.spyOn(ButlerDO.prototype,"reportTaskProgress");
    let result:ToolResultMessage|undefined;
    setModelOverride(scriptedModel([
      {toolCalls:[{name:"codemode",args:{code:'const r=await tools.http_request({url:"https://fixture.test/items",method:"POST",body:"{}"});return r.status;'}}]},
      {text:'{"verdict":"allow","reason":"按指令提交"}'},
      {observe:c=>{result=lastResult(c);},toolCalls:[{name:"finish_task",args:{summary:"allowed flow done"}}]},
    ]));
    reviewedMode();
    const id="t-code-review-allow",stub=task(id);
    await stub.start({taskId:id,title:id,instructions:"post"});
    await complete(stub);
    expect(sent).toBe(1);
    expect(await stub.pendingApprovals()).toEqual([]);
    expect(progress.mock.calls).toContainEqual([id,"自动放行 http_request：按指令提交"]);
    expect(result?.isError).toBe(false);expect(text(result!)).toContain("201");
  });
  it("runs an HTTP POST directly in autonomous mode",async()=>{
    let sent=0;vi.spyOn(globalThis,"fetch").mockImplementation(async()=>{sent++;return new Response("created",{status:201,headers:{"content-type":"text/plain"}});});
    const progress=vi.spyOn(ButlerDO.prototype,"reportTaskProgress");
    const {stub,result}=await script(
      "t-code-autonomous",
      'const r=await tools.http_request({url:"https://fixture.test/items",method:"POST",body:"{}"});return r.status;',
    );
    expect(sent).toBe(1);
    expect(await stub.pendingApprovals()).toEqual([]);
    expect(result.isError).toBe(false);expect(text(result)).toContain("201");
    expect(progress.mock.calls).not.toContainEqual([expect.anything(),expect.stringMatching(/^自动放行/)]);
  });
  it("asks when the reviewer fails",async()=>{
    let sent=0;vi.spyOn(globalThis,"fetch").mockImplementation(async()=>{sent++;return new Response("created",{status:201,headers:{"content-type":"text/plain"}});});
    let result:ToolResultMessage|undefined;
    setModelOverride(scriptedModel([
      {toolCalls:[{name:"codemode",args:{code:'try { const r=await tools.http_request({url:"https://fixture.test/items",method:"POST",body:"{}"});return r.status; } catch(e) { return "caught rejection"; }'}}]},
      {error:"boom"},
      {observe:c=>{result=lastResult(c);},toolCalls:[{name:"finish_task",args:{summary:"failed review done"}}]},
    ]));
    reviewedMode();
    const id="t-code-review-failed",stub=task(id);
    await stub.start({taskId:id,title:id,instructions:"post"});
    let approvalId="";
    await vi.waitFor(async()=>{const pending=await stub.pendingApprovals();expect(pending).toHaveLength(1);approvalId=pending[0]!.approvalId;expect(pending[0]!.reason).toBe("自动审查失败，需要你确认");},{timeout:10_000});
    expect(sent).toBe(0);
    await runInDurableObject(stub,instance=>instance.approvals.resolve(approvalId,"rejected"));
    await complete(stub);
    expect(sent).toBe(0);
    expect(result?.isError).toBe(false);expect(text(result!)).toContain("caught rejection");
  });
  it("reviews against the authorization field",async()=>{
    let seen:TranscriptContext|undefined;
    const sessions:(string|undefined)[]=[];
    vi.spyOn(globalThis,"fetch").mockImplementation(async()=>new Response("created",{status:201,headers:{"content-type":"text/plain"}}));
    setModelOverride(scriptedModel([
      {toolCalls:[{name:"codemode",args:{code:'const r=await tools.http_request({url:"https://fixture.test/items",method:"POST",body:"{}"});return r.status;'}}]},
      {observe:c=>{seen=c;},text:'{"verdict":"allow","reason":"按指令提交"}'},
      {toolCalls:[{name:"finish_task",args:{summary:"authorization review done"}}]},
    ],{onSession:s=>sessions.push(s)}));
    reviewedMode();
    const id="t-code-review-auth",stub=task(id);
    await stub.start({taskId:id,title:id,instructions:"其他内容",authorization:"只允许提交表单"});
    await complete(stub);
    expect(seen).toBeDefined();
    const user=seen!.messages.find(m=>m.role==="user");
    expect(user).toBeDefined();
    const userText=contentText(user!.content);
    expect(userText).toContain("只允许提交表单");expect(userText).not.toContain("其他内容");
    // The review runs outside the harness conversation and needs its own
    // routing session, or OpenCode answers 400 missing_session_id.
    expect(sessions.filter(s=>s?.startsWith("task.review:"))).toHaveLength(1);
    expect(sessions.every(s=>typeof s==="string"&&s!=="")).toBe(true);
    const tools=seen!.messages.filter(m=>m.role==="system").flatMap(m=>m.toolsAdded??[]);
    expect(tools).toEqual([]);
  });
  it("does not treat bot instructions as authorization",async()=>{
    let seen:TranscriptContext|undefined;
    vi.spyOn(globalThis,"fetch").mockImplementation(async()=>new Response("created",{status:201,headers:{"content-type":"text/plain"}}));
    setModelOverride(scriptedModel([
      {toolCalls:[{name:"codemode",args:{code:'const r=await tools.http_request({url:"https://fixture.test/items",method:"POST",body:"{}"});return r.status;'}}]},
      {observe:c=>{seen=c;},text:'{"verdict":"allow","reason":"按指令提交"}'},
      {toolCalls:[{name:"finish_task",args:{summary:"bot review done"}}]},
    ]));
    reviewedMode();
    const id="t-code-review-bot",stub=task(id);
    await stub.start({taskId:id,title:id,instructions:"机器人记忆xyz",botId:"b1"});
    await complete(stub);
    expect(seen).toBeDefined();
    const user=seen!.messages.find(m=>m.role==="user");
    expect(user).toBeDefined();
    expect(contentText(user!.content)).not.toContain("机器人记忆xyz");
  });
  it("calls deferred MCP tools from scripts without loading them into the prompt",async()=>{
    const {result}=await script("t-code-deferred",'return await tools.fixture__echo({text:"from script"});',fixtureMcp);
    expect(result.isError).toBe(false);expect(text(result)).toContain("echo:from script");
  });
  it("loads deferred MCP tools only after a model search",async()=>{
    const offered:string[][]=[];
    const observe=(c:TranscriptContext)=>offered.push(c.messages.filter(m=>m.role==="system").flatMap(m=>m.toolsAdded?.map(t=>t.name)??[]));
    let result:ToolResultMessage|undefined;
    setModelOverride(scriptedModel([
      {observe,toolCalls:[{name:"tool_search",args:{query:"fixture"}}]},
      {observe,toolCalls:[{name:"fixture__echo",args:{text:"loaded"}}]},
      {observe:c=>{result=lastResult(c);},toolCalls:[{name:"finish_task",args:{summary:"search done"}}]},
    ]));
    const stub=task("t-code-search");await fixtureMcp(stub);
    await stub.start({taskId:"t-code-search",title:"search",instructions:"search"});await complete(stub);
    expect(offered[0]).not.toContain("fixture__echo");expect(offered[1]).toContain("fixture__echo");expect(text(result!)).toBe("echo:loaded");
  });
  it("does not offer extra model globals",async()=>{
    const {result}=await script("t-code-models","return typeof models;");
    expect(result.isError).toBe(false);expect(text(result)).toContain("undefined");
  });
  it("bounds oversized script output without claiming a saved full-output file",async()=>{
    const {result}=await script("t-code-output",'// @options: {"max_output_tokens":100}\nreturn "x".repeat(100000);');
    expect(text(result).length).toBeLessThan(100_000);
    expect(result.details).not.toHaveProperty("fullOutputPath");
  });
});

it("installs scripts and search again when a failed task is retried", async () => {
  const id = "t-code-retry";
  const stub = task(id);
  // Retryable failures are only produced by pi's restart-limit report, so seed
  // the durable state a parked task would have instead of forcing a crash loop.
  await runInDurableObject(stub, async (instance) => {
    const target = instance as unknown as {
      setMeta(key: string, value: string): void;
      outboxFor(taskId: string): { emit(body: unknown): Promise<void> };
    };
    target.setMeta("task_id", id);
    target.setMeta("title", id);
    target.setMeta("state", "failed");
    await target.outboxFor(id).emit({ type: "failed", reason: "任务反复中断，已暂停", retryable: true });
  });
  await evictDurableObject(stub);

  const retried = await stub.retryTask();
  expect(retried.ok).toBe(true);

  const names = await runInDurableObject(stub, (instance) =>
    instance.registry.snapshot().tools().map(({ tool }) => tool.name),
  );
  expect(names).toEqual(expect.arrayContaining(["codemode", "tool_search"]));
}, 20_000);

it("keeps a script alive when a page exceeds the script body cap", async () => {
  const chunk = new Uint8Array(256 * 1024).fill(97);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 10) { controller.close(); return; }
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    return new Response(stream, { headers: { "content-type": "text/plain" } });
  });
  const { result } = await script(
    "t-code-big-body",
    'const r = await tools.http_request({url:"https://fixture.test/big"}); return [r.body.length, r.truncated];',
  );
  expect(result.isError).toBe(false);
  expect(text(result)).toContain("1000000");
  expect(text(result)).toContain("true");
}, 20_000);
