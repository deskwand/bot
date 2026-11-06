import { describe, expect, it } from "vitest";
import { clearArtifacts } from "../../scripts/clear-artifacts";

type Call = { method: string; path: string; headers: Record<string, string>; body?: unknown };

function fakeWorker(pages: Array<{ objects: { key: string }[]; next: string | null }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });

    if (url.pathname === "/admin/maintenance/acquire") {
      return new Response(JSON.stringify({ until: 1 }), { status: 200 });
    }
    if (url.pathname === "/admin/maintenance/release") {
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/admin/r2/list") {
      const page = pages.shift();
      if (!page) throw new Error("unexpected list");
      return new Response(JSON.stringify(page), { status: 200 });
    }
    if (init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected call ${url.pathname}`);
  }) as typeof fetch;

  return { calls, fetchImpl };
}

describe("clearArtifacts", () => {
  it("holds a maintenance lease and carries it on every r2 call", async () => {
    const worker = fakeWorker([
      { objects: [{ key: "t1/f1/a.md" }], next: null },
    ]);

    const result = await clearArtifacts({
      workerUrl: "https://bot.example.com",
      adminToken: "token",
      opId: "op-1",
      fetch: worker.fetchImpl,
    });

    expect(result).toEqual({ deleted: 1, skipped: 0 });
    expect(worker.calls.map((call) => call.path)).toEqual([
      "/admin/maintenance/acquire",
      "/admin/r2/list",
      "/admin/r2/object?key=t1%2Ff1%2Fa.md",
      "/admin/maintenance/release",
    ]);
    expect(worker.calls[0]!.body).toEqual({ op: "export", opId: "op-1" });
    for (const call of worker.calls.slice(1)) {
      expect(call.headers["X-Backup-Op"]).toBe("op-1");
    }
  });

  it("only deletes keys shaped like artifacts and follows the cursor", async () => {
    const worker = fakeWorker([
      { objects: [{ key: "t1/f1/a.md" }, { key: "backup.zip" }], next: "c2" },
      { objects: [{ key: "t1/f2/b.md" }], next: null },
    ]);

    const result = await clearArtifacts({
      workerUrl: "https://bot.example.com",
      adminToken: "token",
      opId: "op-2",
      fetch: worker.fetchImpl,
    });

    expect(result).toEqual({ deleted: 2, skipped: 1 });
    const deletes = worker.calls.filter((call) => call.method === "DELETE");
    expect(deletes.map((call) => call.path)).toEqual([
      "/admin/r2/object?key=t1%2Ff1%2Fa.md",
      "/admin/r2/object?key=t1%2Ff2%2Fb.md",
    ]);
    expect(worker.calls.some((call) => call.path.includes("cursor=c2"))).toBe(true);
  });

  it("releases the lease when listing fails", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname === "/admin/maintenance/acquire") {
        return new Response(JSON.stringify({ until: 1 }), { status: 200 });
      }
      if (url.pathname === "/admin/maintenance/release") {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ code: "MAINTENANCE_REQUIRED" }), {
        status: 409,
      });
    }) as typeof fetch;

    await expect(
      clearArtifacts({
        workerUrl: "https://bot.example.com",
        adminToken: "token",
        opId: "op-3",
        fetch: fetchImpl,
      }),
    ).rejects.toThrow("list failed: 409");
    expect(calls).toContain("/admin/maintenance/release");
  });
});
