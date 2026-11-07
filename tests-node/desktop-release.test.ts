import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  changelogHasVersion,
  checkPublishedVersion,
  compareVersions,
  findArchive,
  isEntryPoint,
  manifestUrl,
  parseTarget,
  verifyPublished,
  verifyPublishedAssets,
  versionsInSync,
} from "../scripts/desktop-release";

const MANIFEST_URL = "https://updates.example.com/bot/update-darwin-arm64.json";
const ARCHIVE = "deskwand-bot-0.1.6-darwin-arm64.tar.gz";
const WINDOWS_ARCHIVE = "deskwand-bot-0.1.6-windows-amd64.tar.gz";
const DARWIN_INSTALLER = "deskwand-bot-0.1.6-arm64.dmg";
const WINDOWS_INSTALLER = "deskwand-bot-setup-0.1.6-amd64.exe";

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
    expect(findArchive(dir, "0.1.6", "darwin-arm64")).toBe(archive);
  });

  it("rejects zero or many", () => {
    const empty = tempDir();
    expect(() => findArchive(empty, "0.1.6", "darwin-arm64")).toThrow();

    const many = tempDir();
    writeFileSync(join(many, ARCHIVE), "abc");
    writeFileSync(join(many, "old-0.1.6-darwin-arm64.tar.gz"), "abc");
    expect(() => findArchive(many, "0.1.6", "darwin-arm64")).toThrow();
  });

  it("finds the windows archive and ignores the darwin one", () => {
    const dir = tempDir();
    const windows = join(dir, "deskwand-bot-0.1.6-windows-amd64.tar.gz");
    writeFileSync(windows, "abc");
    writeFileSync(join(dir, ARCHIVE), "abc");
    expect(findArchive(dir, "0.1.6", "windows-amd64")).toBe(windows);
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

describe("parseTarget", () => {
  it("accepts the two published targets", () => {
    expect(parseTarget("darwin-arm64")).toBe("darwin-arm64");
    expect(parseTarget("windows-amd64")).toBe("windows-amd64");
  });

  it("rejects anything else", () => {
    expect(() => parseTarget("windows/amd64")).toThrow();
    expect(() => parseTarget("linux-amd64")).toThrow();
    expect(() => parseTarget("")).toThrow();
  });
});

describe("manifestUrl", () => {
  it("derives the manifest from the target", () => {
    expect(manifestUrl("darwin-arm64", {})).toBe(
      "https://updates.example.com/bot/update-darwin-arm64.json",
    );
    expect(manifestUrl("windows-amd64", {})).toBe(
      "https://updates.example.com/bot/update-windows-amd64.json",
    );
  });

  it("reads DESKWAND_UPDATE_BASE and trims trailing slashes", () => {
    expect(manifestUrl("windows-amd64", { DESKWAND_UPDATE_BASE: "https://example.com/bot/" })).toBe(
      "https://example.com/bot/update-windows-amd64.json",
    );
    expect(manifestUrl("windows-amd64", { DESKWAND_UPDATE_BASE: "https://example.com/bot///" })).toBe(
      "https://example.com/bot/update-windows-amd64.json",
    );
  });

  it("falls back to the default base for an empty or blank override", () => {
    for (const value of ["", "   "]) {
      expect(manifestUrl("darwin-arm64", { DESKWAND_UPDATE_BASE: value })).toBe(
        "https://updates.example.com/bot/update-darwin-arm64.json",
      );
    }
  });
});

type Artifact = { name: string; content: string };

const DARWIN_ARTIFACTS: Artifact[] = [
  { name: ARCHIVE, content: "darwin archive" },
  { name: DARWIN_INSTALLER, content: "darwin dmg" },
  { name: "install.sh", content: "#!/bin/sh\n" },
];

const WINDOWS_ARTIFACTS: Artifact[] = [
  { name: WINDOWS_ARCHIVE, content: "windows archive" },
  { name: WINDOWS_INSTALLER, content: "windows exe" },
  { name: "install.ps1", content: "Write-Output windows\n" },
];

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function materialize(dir: string, artifacts: Artifact[]): void {
  for (const artifact of artifacts) writeFileSync(join(dir, artifact.name), artifact.content);
}

function sumsFor(artifacts: Artifact[], separator = "  ", eol = "\n"): string {
  return artifacts.map((a) => `${sha256(a.content)}${separator}${a.name}`).join(eol) + eol;
}

function releaseFetch(options: {
  sums: string;
  remote: Artifact[];
  sumsStatus?: number;
  remoteOverride?: Record<string, string>;
  unavailable?: string[];
}): { fetchFn: typeof fetch; requested: string[] } {
  const requested: string[] = [];
  const bodies = new Map(options.remote.map((artifact) => [artifact.name, artifact.content]));
  const fetchFn = fakeFetch((url) => {
    requested.push(url);
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    if (name === "SHA256SUMS") {
      return new Response(options.sums, { status: options.sumsStatus ?? 200 });
    }
    if (options.unavailable?.includes(name)) return new Response("", { status: 404 });
    const body = options.remoteOverride?.[name] ?? bodies.get(name);
    if (body === undefined) return new Response("", { status: 404 });
    return new Response(body, { status: 200 });
  });
  return { fetchFn, requested };
}

describe("verifyPublishedAssets", () => {
  it("verifies the macOS installer, script and archive", async () => {
    const dir = tempDir();
    materialize(dir, DARWIN_ARTIFACTS);
    const { fetchFn } = releaseFetch({ sums: sumsFor(DARWIN_ARTIFACTS), remote: DARWIN_ARTIFACTS });

    await expect(
      verifyPublishedAssets({
        target: "darwin-arm64",
        version: "0.1.6",
        buildDir: dir,
        fetchFn,
        env: {},
      }),
    ).resolves.toBeUndefined();
  });

  it("verifies the Windows installer, script and archive", async () => {
    const dir = tempDir();
    materialize(dir, WINDOWS_ARTIFACTS);
    const { fetchFn } = releaseFetch({
      sums: sumsFor(WINDOWS_ARTIFACTS),
      remote: WINDOWS_ARTIFACTS,
    });

    await expect(
      verifyPublishedAssets({
        target: "windows-amd64",
        version: "0.1.6",
        buildDir: dir,
        fetchFn,
        env: {},
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts sha256sum's star separator and CRLF line endings", async () => {
    const dir = tempDir();
    materialize(dir, WINDOWS_ARTIFACTS);
    const { fetchFn } = releaseFetch({
      sums: sumsFor(WINDOWS_ARTIFACTS, " *", "\r\n"),
      remote: WINDOWS_ARTIFACTS,
    });

    await expect(
      verifyPublishedAssets({
        target: "windows-amd64",
        version: "0.1.6",
        buildDir: dir,
        fetchFn,
        env: {},
      }),
    ).resolves.toBeUndefined();
  });

  it("uses a cache-busting query for SHA256SUMS", async () => {
    const dir = tempDir();
    materialize(dir, DARWIN_ARTIFACTS);
    const { fetchFn, requested } = releaseFetch({
      sums: sumsFor(DARWIN_ARTIFACTS),
      remote: DARWIN_ARTIFACTS,
    });

    await verifyPublishedAssets({
      target: "darwin-arm64",
      version: "0.1.6",
      buildDir: dir,
      fetchFn,
      env: {},
      now: () => 11,
    });

    const sumsRequest = requested.find((url) => url.includes("SHA256SUMS"));
    expect(sumsRequest).toBe("https://updates.example.com/bot/SHA256SUMS?t=11");
  });

  it("rejects a missing local installer", async () => {
    const dir = tempDir();
    materialize(
      dir,
      DARWIN_ARTIFACTS.filter((artifact) => artifact.name !== DARWIN_INSTALLER),
    );
    const { fetchFn } = releaseFetch({ sums: sumsFor(DARWIN_ARTIFACTS), remote: DARWIN_ARTIFACTS });

    await expect(
      verifyPublishedAssets({
        target: "darwin-arm64",
        version: "0.1.6",
        buildDir: dir,
        fetchFn,
        env: {},
      }),
    ).rejects.toThrow();
  });

  it("rejects a local file that does not match the published checksum", async () => {
    const dir = tempDir();
    materialize(dir, WINDOWS_ARTIFACTS);
    writeFileSync(join(dir, WINDOWS_INSTALLER), "tampered exe");
    const { fetchFn } = releaseFetch({
      sums: sumsFor(WINDOWS_ARTIFACTS),
      remote: WINDOWS_ARTIFACTS,
    });

    await expect(
      verifyPublishedAssets({
        target: "windows-amd64",
        version: "0.1.6",
        buildDir: dir,
        fetchFn,
        env: {},
      }),
    ).rejects.toThrow();
  });

  it("rejects an unreachable or different remote script", async () => {
    const dir = tempDir();
    materialize(dir, DARWIN_ARTIFACTS);

    await expect(
      verifyPublishedAssets({
        target: "darwin-arm64",
        version: "0.1.6",
        buildDir: dir,
        env: {},
        fetchFn: releaseFetch({
          sums: sumsFor(DARWIN_ARTIFACTS),
          remote: DARWIN_ARTIFACTS,
          unavailable: ["install.sh"],
        }).fetchFn,
      }),
    ).rejects.toThrow();

    await expect(
      verifyPublishedAssets({
        target: "darwin-arm64",
        version: "0.1.6",
        buildDir: dir,
        env: {},
        fetchFn: releaseFetch({
          sums: sumsFor(DARWIN_ARTIFACTS),
          remote: DARWIN_ARTIFACTS,
          remoteOverride: { "install.sh": "#!/bin/sh\necho other\n" },
        }).fetchFn,
      }),
    ).rejects.toThrow();
  });

  it("rejects a same-length tampered remote script or installer", async () => {
    // 远端内容被换成等长数据，SHA256SUMS 仍对应本地文件：长度检查会放行，
    // 只有逐字节的 SHA-256 比较能发现篡改。
    const dir = tempDir();
    materialize(dir, DARWIN_ARTIFACTS);
    const localScript = DARWIN_ARTIFACTS.find((a) => a.name === "install.sh")!.content;
    const tamperedScript = "#!/bin/xx\n";
    expect(Buffer.byteLength(tamperedScript)).toBe(Buffer.byteLength(localScript));
    expect(tamperedScript).not.toBe(localScript);

    await expect(
      verifyPublishedAssets({
        target: "darwin-arm64",
        version: "0.1.6",
        buildDir: dir,
        env: {},
        fetchFn: releaseFetch({
          sums: sumsFor(DARWIN_ARTIFACTS),
          remote: DARWIN_ARTIFACTS,
          remoteOverride: { "install.sh": tamperedScript },
        }).fetchFn,
      }),
    ).rejects.toThrow("公网 install.sh 的 SHA-256 与本地不一致");

    const windowsDir = tempDir();
    materialize(windowsDir, WINDOWS_ARTIFACTS);
    const localInstaller = WINDOWS_ARTIFACTS.find((a) => a.name === WINDOWS_INSTALLER)!.content;
    const tamperedInstaller = "WINDOWS EXE";
    expect(Buffer.byteLength(tamperedInstaller)).toBe(Buffer.byteLength(localInstaller));

    await expect(
      verifyPublishedAssets({
        target: "windows-amd64",
        version: "0.1.6",
        buildDir: windowsDir,
        env: {},
        fetchFn: releaseFetch({
          sums: sumsFor(WINDOWS_ARTIFACTS),
          remote: WINDOWS_ARTIFACTS,
          remoteOverride: { [WINDOWS_INSTALLER]: tamperedInstaller },
        }).fetchFn,
      }),
    ).rejects.toThrow(`公网 ${WINDOWS_INSTALLER} 的 SHA-256 与本地不一致`);
  });

  it("rejects a missing or duplicate checksum line", async () => {
    const dir = tempDir();
    materialize(dir, WINDOWS_ARTIFACTS);

    const missing = WINDOWS_ARTIFACTS.filter((artifact) => artifact.name !== "install.ps1");
    await expect(
      verifyPublishedAssets({
        target: "windows-amd64",
        version: "0.1.6",
        buildDir: dir,
        env: {},
        fetchFn: releaseFetch({ sums: sumsFor(missing), remote: WINDOWS_ARTIFACTS }).fetchFn,
      }),
    ).rejects.toThrow();

    const duplicated = `${sumsFor(WINDOWS_ARTIFACTS)}${sha256("windows exe")}  ${WINDOWS_INSTALLER}\n`;
    await expect(
      verifyPublishedAssets({
        target: "windows-amd64",
        version: "0.1.6",
        buildDir: dir,
        env: {},
        fetchFn: releaseFetch({ sums: duplicated, remote: WINDOWS_ARTIFACTS }).fetchFn,
      }),
    ).rejects.toThrow();
  });

  it("rejects an unreadable or malformed SHA256SUMS", async () => {
    const dir = tempDir();
    materialize(dir, DARWIN_ARTIFACTS);

    await expect(
      verifyPublishedAssets({
        target: "darwin-arm64",
        version: "0.1.6",
        buildDir: dir,
        env: {},
        fetchFn: releaseFetch({
          sums: sumsFor(DARWIN_ARTIFACTS),
          remote: DARWIN_ARTIFACTS,
          sumsStatus: 503,
        }).fetchFn,
      }),
    ).rejects.toThrow();

    for (const sums of ["not a checksum line\n", `${sha256("x")} ${DARWIN_INSTALLER}\n`, ""]) {
      await expect(
        verifyPublishedAssets({
          target: "darwin-arm64",
          version: "0.1.6",
          buildDir: dir,
          env: {},
          fetchFn: releaseFetch({ sums, remote: DARWIN_ARTIFACTS }).fetchFn,
        }),
      ).rejects.toThrow();
    }
  });

  it("keeps the first platform's line when publishing the second", async () => {
    const dir = tempDir();
    materialize(dir, WINDOWS_ARTIFACTS);
    writeFileSync(join(dir, ARCHIVE), "darwin archive");

    const both = [...WINDOWS_ARTIFACTS, ...DARWIN_ARTIFACTS];
    await expect(
      verifyPublishedAssets({
        target: "windows-amd64",
        version: "0.1.6",
        buildDir: dir,
        otherTarget: "darwin-arm64",
        env: {},
        fetchFn: releaseFetch({ sums: sumsFor(both), remote: both }).fetchFn,
      }),
    ).resolves.toBeUndefined();

    await expect(
      verifyPublishedAssets({
        target: "windows-amd64",
        version: "0.1.6",
        buildDir: dir,
        otherTarget: "darwin-arm64",
        env: {},
        fetchFn: releaseFetch({ sums: sumsFor(WINDOWS_ARTIFACTS), remote: both }).fetchFn,
      }),
    ).rejects.toThrow();
  });

  it("does not require the other platform when publishing alone", async () => {
    const dir = tempDir();
    materialize(dir, DARWIN_ARTIFACTS);
    const { fetchFn } = releaseFetch({ sums: sumsFor(DARWIN_ARTIFACTS), remote: DARWIN_ARTIFACTS });

    await expect(
      verifyPublishedAssets({
        target: "darwin-arm64",
        version: "0.1.6",
        buildDir: dir,
        fetchFn,
        env: {},
      }),
    ).resolves.toBeUndefined();
  });
});

describe("isEntryPoint", () => {
  // A release run from a symlinked path (macOS /tmp -> /private/tmp) used to
  // look "imported", so main() never ran and the process still exited 0.
  it("recognizes an entry path that reaches the module through a symlink", () => {
    const dir = tempDir();
    const real = join(dir, "desktop-release.ts");
    const link = join(dir, "link.ts");
    writeFileSync(real, "");
    symlinkSync(real, link);
    const moduleUrl = pathToFileURL(real).href;
    expect(isEntryPoint(link, moduleUrl)).toBe(true);
    expect(isEntryPoint(real, moduleUrl)).toBe(true);
  });

  it("rejects a different file and a missing argument", () => {
    const dir = tempDir();
    const real = join(dir, "desktop-release.ts");
    const other = join(dir, "other.ts");
    writeFileSync(real, "");
    writeFileSync(other, "");
    const moduleUrl = pathToFileURL(real).href;
    expect(isEntryPoint(other, moduleUrl)).toBe(false);
    expect(isEntryPoint(undefined, moduleUrl)).toBe(false);
    expect(isEntryPoint(join(dir, "missing.ts"), moduleUrl)).toBe(false);
  });
});
