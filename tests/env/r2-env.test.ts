import type { Context } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_DRAFT_BYTES, createR2WorkspaceEnv } from "../../src/env/r2-env";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const ctx = { abortSignal: undefined } as unknown as Context;
const envFor = (id = "t1") => createR2WorkspaceEnv(env.ARTIFACTS, id);

describe("createR2WorkspaceEnv", () => {
  it("maps relative and rooted paths onto the virtual root", async () => {
    const e = envFor();
    expect(await e.absolutePath("a.md", ctx)).toEqual({ ok: true, value: "/a.md" });
    expect(await e.absolutePath("/notes/b.md", ctx)).toEqual({ ok: true, value: "/notes/b.md" });
    expect(await e.absolutePath("./c.md", ctx)).toEqual({ ok: true, value: "/c.md" });
  });

  it("rejects paths that escape the workspace", async () => {
    for (const path of ["../x", "a/../../b", "a//b", "a\u0000b", ""]) {
      const result = await envFor().absolutePath(path, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid");
    }
  });

  it("points artifact and inbox keys to get_artifact", async () => {
    for (const path of ["t3/abc/report.md", "inbox/tg:1/a.pdf"]) {
      const result = await envFor().absolutePath(path, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("get_artifact");
    }
  });

  it("writes, stats and reads back under work/<taskId>/", async () => {
    const e = envFor();
    expect((await e.writeFile("/a.md", "第一行\n第二行", ctx)).ok).toBe(true);
    expect(await env.ARTIFACTS.head("work/t1/a.md")).not.toBeNull();
    const info = await e.fileInfo("/a.md", ctx);
    expect(info.ok && info.value).toMatchObject({
      name: "a.md",
      path: "/a.md",
      kind: "file",
      size: 19,
    });
    expect(await e.readTextFile("/a.md", ctx)).toEqual({ ok: true, value: "第一行\n第二行" });
    expect(await e.exists("/a.md", ctx)).toEqual({ ok: true, value: true });
    expect(await e.exists("/missing.md", ctx)).toEqual({ ok: true, value: false });
  });

  it("shares skill files but keeps ordinary drafts private", async () => {
    const a = envFor("t-skill-a");
    const b = envFor("t-skill-b");

    expect((await a.writeFile("/skills/demo/SKILL.md", "v1", ctx)).ok).toBe(true);
    expect(await env.ARTIFACTS.get("skills/demo/SKILL.md")).not.toBeNull();
    expect(await b.readTextFile("skills/demo/SKILL.md", ctx)).toEqual({
      ok: true,
      value: "v1",
    });
    expect(await b.fileInfo("/skills/demo/SKILL.md", ctx)).toMatchObject({
      ok: true,
      value: { path: "/skills/demo/SKILL.md", name: "SKILL.md" },
    });
    expect(await b.exists("/skills/demo/SKILL.md", ctx)).toEqual({
      ok: true,
      value: true,
    });

    await a.writeFile("notes.md", "private", ctx);
    expect((await b.readTextFile("notes.md", ctx)).ok).toBe(false);

    await a.writeFile("/skills/demo/SKILL.md", "v2", ctx);
    expect(await b.readTextFile("/skills/demo/SKILL.md", ctx)).toEqual({
      ok: true,
      value: "v2",
    });
  });

  it("reads a shared skill through the binary reader", async () => {
    const e = envFor("t-skill-r");
    await e.writeFile("/skills/demo/notes.txt", "a\nbb\nccc\n", ctx);
    const opened = await e.openBinaryReader(
      "/skills/demo/notes.txt",
      undefined,
      ctx,
    );
    if (!opened.ok) throw opened.error;

    const reader = opened.value;
    expect(
      new TextDecoder().decode(getOrThrow(await reader.read(2, 2, ctx))),
    ).toBe("bb");
    expect(
      getOrThrow(await reader.scanLines({ startLine: 1, endLine: 2 }, ctx))
        .newlines,
    ).toBe(3);
  });

  it("rejects shared skill paths that could never be discovered", async () => {
    const e = envFor();
    for (const path of [
      "/skills/x",
      "/skills/Bad/SKILL.md",
      "/skills/-a/SKILL.md",
      "/skills/",
    ]) {
      const wrote = await e.writeFile(path, "x", ctx);
      expect(!wrote.ok && wrote.error.code).toBe("invalid");
      const read = await e.readTextFile(path, ctx);
      expect(!read.ok && read.error.code).toBe("invalid");
    }
    expect(await env.ARTIFACTS.head("skills/x")).toBeNull();
    expect(await env.ARTIFACTS.head("skills/Bad/SKILL.md")).toBeNull();
    expect(await env.ARTIFACTS.head("skills/-a/SKILL.md")).toBeNull();

    // A lone `skills` segment is an ordinary private draft, not the library.
    expect((await e.writeFile("skills", "x", ctx)).ok).toBe(true);
    expect(await env.ARTIFACTS.head("work/t1/skills")).not.toBeNull();
  });

  it("refuses a shared skill file over 1 MB", async () => {
    const e = envFor();
    const result = await e.writeFile(
      "/skills/demo/big.md",
      "x".repeat(MAX_DRAFT_BYTES + 1),
      ctx,
    );
    expect(!result.ok && result.error.code).toBe("invalid");
    expect(await env.ARTIFACTS.head("skills/demo/big.md")).toBeNull();
  });

  it("reports a missing file as not_found", async () => {
    const result = await envFor().fileInfo("/none.md", ctx);
    expect(!result.ok && result.error.code).toBe("not_found");
  });

  it("refuses a write over 1 MB", async () => {
    const result = await envFor().writeFile("/big.md", "x".repeat(MAX_DRAFT_BYTES + 1), ctx);
    expect(!result.ok && result.error.code).toBe("invalid");
    expect(await env.ARTIFACTS.head("work/t1/big.md")).toBeNull();
  });

  it("reads byte ranges and scans lines through a binary reader", async () => {
    const e = envFor();
    await e.writeFile("/l.txt", "a\nbb\nccc\n", ctx);
    const opened = await e.openBinaryReader("/l.txt", undefined, ctx);
    if (!opened.ok) throw opened.error;
    const reader = opened.value;
    expect(new TextDecoder().decode(getOrThrow(await reader.read(2, 2, ctx)))).toBe("bb");
    const scan = getOrThrow(await reader.scanLines({ startLine: 1, endLine: 2 }, ctx));
    expect(scan.newlines).toBe(3);
    await reader.close(ctx);
  });

  it("declines what it does not implement without throwing", async () => {
    const e = envFor();
    const canonical = await e.canonicalPath("/a.md", ctx);
    expect(!canonical.ok && canonical.error.code).toBe("not_supported");
    const exec = await e.exec("ls", undefined, ctx);
    expect(!exec.ok && exec.error.code).toBe("shell_unavailable");
    expect(e.id).toBe("r2:work:t1");
    expect(e.cwd).toBe("/");
  });

  it("explains that temporary files are not saved", async () => {
    const e = envFor();
    for (const result of [
      await e.createTempDir("tmp", ctx),
      await e.createTempFile({ prefix: "tmp" }, ctx),
    ]) {
      expect(!result.ok && result.error.message).toBe(
        "草稿区不提供临时文件，完整输出未保存",
      );
    }
  });
});
