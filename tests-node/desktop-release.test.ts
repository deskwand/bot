import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  changelogHasVersion,
  checkPublishedVersion,
  compareVersions,
  findArchive,
  verifyPublished,
  versionsInSync,
} from "../scripts/desktop-release";

const MANIFEST_URL = "https://updates.example.com/bot/update-darwin-arm64.json";
const ARCHIVE = "deskwand-bot-0.1.6-darwin-arm64.tar.gz";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "desktop-release-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  const fn = async (input: unknown) => handler(String(input));
  return fn as unknown as typeof fetch;
}

function localArchive(content = "abc", name = ARCHIVE): string {
  const path = join(tempDir(), name);
  writeFileSync(path, content);
  return path;
}

describe("compareVersions", () => {
  it("compares numeric segments", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.1.6", "0.1.6")).toBe(0);
    expect(compareVersions("0.1.5", "0.1.6")).toBeLessThan(0);
  });

  it("rejects anything that is not x.y.z", () => {
    expect(() => compareVersions("1.0", "1.0.0")).toThrow();
    expect(() => compareVersions("1.0.0-beta", "1.0.0")).toThrow();
  });
});

describe("changelogHasVersion", () => {
  it("matches plain and bracketed headings", () => {
    expect(changelogHasVersion("## 0.1.6\n", "0.1.6")).toBe(true);
    expect(changelogHasVersion("## [0.1.6] - 2026-11-04\n", "0.1.6")).toBe(true);
  });

  it("does not match a longer version", () => {
    expect(changelogHasVersion("## 0.1.60\n", "0.1.6")).toBe(false);
  });
});

describe("versionsInSync", () => {
  it("reports the mismatched file", () => {
    const message = versionsInSync({ mygo: "0.1.6", frontend: "0.1.5", mainGo: "0.1.6" });
    expect(message).toContain("desktop/frontend/package.json");
  });

  it("returns null when the three versions agree", () => {
    expect(versionsInSync({ mygo: "0.1.6", frontend: "0.1.6", mainGo: "0.1.6" })).toBeNull();
  });
});

describe("findArchive", () => {
  it("returns the only matching archive", () => {
    const dir = tempDir();
    const archive = join(dir, ARCHIVE);
    writeFileSync(archive, "abc");
    expect(findArchive(dir, "0.1.6")).toBe(archive);
  });

  it("rejects zero or many", () => {
    const empty = tempDir();
    expect(() => findArchive(empty, "0.1.6")).toThrow();

    const many = tempDir();
    writeFileSync(join(many, ARCHIVE), "abc");
    writeFileSync(join(many, "old-0.1.6-darwin-arm64.tar.gz"), "abc");
    expect(() => findArchive(many, "0.1.6")).toThrow();
  });
});

describe("checkPublishedVersion", () => {
  it("uses a cache-busting query", async () => {
    const requested: string[] = [];
    const fetchFn = fakeFetch((url) => {
      requested.push(url);
      return new Response("", { status: 404 });
    });

    await expect(
      checkPublishedVersion(MANIFEST_URL, "0.1.6", fetchFn, () => 7),
    ).resolves.toEqual({ firstRelease: true });
    expect(requested[0]?.endsWith("?t=7")).toBe(true);
  });

  it("treats 404 as a first release", async () => {
    const fetchFn = fakeFetch(() => new Response("", { status: 404 }));
    await expect(checkPublishedVersion(MANIFEST_URL, "0.1.6", fetchFn)).resolves.toEqual({
      firstRelease: true,
    });
  });

  it("returns the published version when it is lower", async () => {
    const fetchFn = fakeFetch(
      () => new Response(JSON.stringify({ version: "0.1.5" }), { status: 200 }),
    );
    await expect(checkPublishedVersion(MANIFEST_URL, "0.1.6", fetchFn)).resolves.toEqual({
      firstRelease: false,
      published: "0.1.5",
    });
  });

  it("rejects the same or a higher published version", async () => {
    for (const published of ["0.1.6", "0.1.7"]) {
      const fetchFn = fakeFetch(
        () => new Response(JSON.stringify({ version: published }), { status: 200 }),
      );
      await expect(checkPublishedVersion(MANIFEST_URL, "0.1.6", fetchFn)).rejects.toThrow();
    }
  });

  it("rejects an unsuccessful, malformed or versionless response", async () => {
    const responses = [
      () => new Response("", { status: 503 }),
      () => new Response("not json", { status: 200 }),
      () => new Response("{}", { status: 200 }),
    ];
    for (const response of responses) {
      await expect(
        checkPublishedVersion(MANIFEST_URL, "0.1.6", fakeFetch(response)),
      ).rejects.toThrow();
    }

    const offline = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(checkPublishedVersion(MANIFEST_URL, "0.1.6", offline)).rejects.toThrow();
  });
});

describe("verifyPublished", () => {
  it("accepts a manifest and archive that match the local build", async () => {
    const local = localArchive();
    const fetchFn = fakeFetch((url) => {
      if (url.includes("update-darwin-arm64.json")) {
        return new Response(
          JSON.stringify({
            version: "0.1.6",
            url: `https://updates.example.com/bot/${ARCHIVE}`,
            size: 3,
          }),
          { status: 200 },
        );
      }
      return new Response("abc", { status: 200 });
    });

    await expect(
      verifyPublished({ manifestUrl: MANIFEST_URL, version: "0.1.6", localArchive: local, fetchFn }),
    ).resolves.toBeUndefined();
  });

  it("uses a cache-busting query", async () => {
    const local = localArchive();
    const requested: string[] = [];
    const fetchFn = fakeFetch((url) => {
      requested.push(url);
      if (url.includes("update-darwin-arm64.json")) {
        return new Response(
          JSON.stringify({
            version: "0.1.6",
            url: `https://updates.example.com/bot/${ARCHIVE}`,
            size: 3,
          }),
          { status: 200 },
        );
      }
      return new Response("abc", { status: 200 });
    });

    await verifyPublished({
      manifestUrl: MANIFEST_URL,
      version: "0.1.6",
      localArchive: local,
      fetchFn,
      now: () => 42,
    });

    expect(requested.find((url) => url.includes("update-darwin-arm64.json"))).toBe(
      `${MANIFEST_URL}?t=42`,
    );
  });

  it("rejects a different manifest version", async () => {
    const local = localArchive();
    const fetchFn = fakeFetch((url) => {
      if (url.includes("update-darwin-arm64.json")) {
        return new Response(
          JSON.stringify({
            version: "0.1.5",
            url: `https://updates.example.com/bot/${ARCHIVE}`,
            size: 3,
          }),
          { status: 200 },
        );
      }
      return new Response("abc", { status: 200 });
    });

    await expect(
      verifyPublished({ manifestUrl: MANIFEST_URL, version: "0.1.6", localArchive: local, fetchFn }),
    ).rejects.toThrow();
  });

  it("rejects a manifest size that differs from the local archive", async () => {
    const local = localArchive();
    const fetchFn = fakeFetch((url) => {
      if (url.includes("update-darwin-arm64.json")) {
        return new Response(
          JSON.stringify({
            version: "0.1.6",
            url: `https://updates.example.com/bot/${ARCHIVE}`,
            size: 4,
          }),
          { status: 200 },
        );
      }
      return new Response("abc", { status: 200 });
    });

    await expect(
      verifyPublished({ manifestUrl: MANIFEST_URL, version: "0.1.6", localArchive: local, fetchFn }),
    ).rejects.toThrow();
  });

  it("rejects archive bytes that differ even when the size matches", async () => {
    const local = localArchive();
    const fetchFn = fakeFetch((url) => {
      if (url.includes("update-darwin-arm64.json")) {
        return new Response(
          JSON.stringify({
            version: "0.1.6",
            url: `https://updates.example.com/bot/${ARCHIVE}`,
            size: 3,
          }),
          { status: 200 },
        );
      }
      return new Response("abd", { status: 200 });
    });

    await expect(
      verifyPublished({ manifestUrl: MANIFEST_URL, version: "0.1.6", localArchive: local, fetchFn }),
    ).rejects.toThrow();
  });

  it("rejects an archive URL with a different filename", async () => {
    const local = localArchive();
    const fetchFn = fakeFetch((url) => {
      if (url.includes("update-darwin-arm64.json")) {
        return new Response(
          JSON.stringify({
            version: "0.1.6",
            url: "https://updates.example.com/bot/other-0.1.6-darwin-arm64.tar.gz",
            size: 3,
          }),
          { status: 200 },
        );
      }
      return new Response("abc", { status: 200 });
    });

    await expect(
      verifyPublished({ manifestUrl: MANIFEST_URL, version: "0.1.6", localArchive: local, fetchFn }),
    ).rejects.toThrow();
  });
});
