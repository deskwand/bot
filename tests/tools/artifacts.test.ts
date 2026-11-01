import type { Context } from "@earendil-works/chord";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { saveArtifactTool } from "../../src/tools/artifacts";

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
  it("stores the file under the task id and returns its public URL", async () => {
    const baseUrl = "https://example.com";
    const tool = saveArtifactTool(env.ARTIFACTS, () => "t1", baseUrl);

    const result = await tool.execute(
      { filename: "report.md", content: "# Report" },
      {} as never,
      context(),
    );
    const text = textOf(result);
    const url = text.match(/https:\/\/example\.com\/a\/\S+/)?.[0];

    expect(url).toBeDefined();
    expect(url!.startsWith(`${baseUrl}/a/t1/`)).toBe(true);
    expect(url!.endsWith("/report.md")).toBe(true);

    const key = decodeURIComponent(new URL(url!).pathname.slice("/a/".length));
    const object = await env.ARTIFACTS.get(key);
    expect(await object?.text()).toBe("# Report");
    expect(object?.httpMetadata?.contentType).toBe(
      "text/markdown; charset=utf-8",
    );
  });

  it("sanitizes traversal characters and encodes each key segment in the link", async () => {
    const baseUrl = "https://example.com";
    const tool = saveArtifactTool(env.ARTIFACTS, () => "t3", baseUrl);

    const result = await tool.execute(
      { filename: "../x/报告 v1?.md", content: "body" },
      {} as never,
      context(),
    );
    const url = textOf(result).match(/https:\/\/example\.com\/a\/\S+/)?.[0];

    expect(url).toBeDefined();
    const path = new URL(url!).pathname;
    const key = decodeURIComponent(path.slice("/a/".length));

    expect(key.split("/")).toHaveLength(3);
    expect(key.startsWith("t3/")).toBe(true);
    expect(key.endsWith("/报告_v1_.md")).toBe(true);
    expect(key).not.toContain("..");
    expect(await (await env.ARTIFACTS.get(key))?.text()).toBe("body");
  });

  it("honours a custom content type", async () => {
    const tool = saveArtifactTool(env.ARTIFACTS, () => "t2", "https://example.com");

    const result = await tool.execute(
      { filename: "data.json", content: "{}", contentType: "application/json" },
      {} as never,
      context(),
    );
    const url = textOf(result).match(/https:\/\/example\.com\/a\/\S+/)?.[0];
    const key = decodeURIComponent(new URL(url!).pathname.slice("/a/".length));

    expect((await env.ARTIFACTS.get(key))?.httpMetadata?.contentType).toBe(
      "application/json",
    );
  });
});
