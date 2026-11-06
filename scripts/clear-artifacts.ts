// 一次性脚本：清空 R2 里的历史产物对象（产物不再通过公开链接访问）。
// 跑完即删。用法：
//   node --experimental-strip-types scripts/clear-artifacts.ts <workerUrl> <adminToken>
import { artifactKeySegments } from "../src/artifact.ts";

const OP_HEADER = "X-Backup-Op";

type Fetch = typeof fetch;

export type ClearDeps = {
  workerUrl: string;
  adminToken: string;
  fetch?: Fetch;
  opId?: string;
};

/**
 * `/admin/r2/*` 只在备份租约下开放，所以先取租约再逐条删除。
 * 只删形状合法的产物 key：这既是"桶里只有产物"的断言，也防止误删别的对象。
 */
export async function clearArtifacts(deps: ClearDeps): Promise<{
  deleted: number;
  skipped: number;
}> {
  const fetchImpl = deps.fetch ?? fetch;
  const opId = deps.opId ?? crypto.randomUUID();
  const auth = { authorization: `Bearer ${deps.adminToken}` };

  const acquired = await fetchImpl(new URL("/admin/maintenance/acquire", deps.workerUrl), {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ op: "export", opId }),
  });
  if (!acquired.ok) {
    throw new Error(`acquire failed: ${acquired.status}`);
  }

  const headers = { ...auth, [OP_HEADER]: opId };
  let deleted = 0;
  let skipped = 0;

  try {
    let cursor: string | null = null;
    do {
      const url = new URL("/admin/r2/list", deps.workerUrl);
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await fetchImpl(url, { headers });
      if (!response.ok) throw new Error(`list failed: ${response.status}`);
      // r2-routes 的 list 返回 { objects: [{ key, size, contentType }], next }。
      const page = (await response.json()) as {
        objects: { key: string }[];
        next: string | null;
      };

      for (const object of page.objects) {
        if (artifactKeySegments(object.key) === null) {
          skipped += 1;
          continue;
        }
        const target = new URL("/admin/r2/object", deps.workerUrl);
        target.searchParams.set("key", object.key);
        const removed = await fetchImpl(target, { method: "DELETE", headers });
        if (!removed.ok && removed.status !== 404) {
          throw new Error(`delete failed for ${object.key}: ${removed.status}`);
        }
        if (removed.ok) deleted += 1;
      }

      cursor = page.next;
    } while (cursor !== null);
  } finally {
    await fetchImpl(new URL("/admin/maintenance/release", deps.workerUrl), {
      method: "POST",
      headers,
    }).catch(() => undefined);
  }

  return { deleted, skipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [workerUrl, adminToken] = process.argv.slice(2);
  if (!workerUrl || !adminToken) {
    console.error(
      "用法：node --experimental-strip-types scripts/clear-artifacts.ts <workerUrl> <adminToken>",
    );
    process.exit(1);
  }
  const result = await clearArtifacts({ workerUrl, adminToken });
  console.log(
    `deleted ${result.deleted} artifact objects (skipped ${result.skipped} non-artifact keys)`,
  );
}
