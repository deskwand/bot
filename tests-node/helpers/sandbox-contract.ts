import { describe, expect, it } from "vitest";
import type { SandboxProvider } from "../../src/sandbox/types";

/**
 * Behaviour every SandboxProvider must have. A future Cloudflare adapter runs
 * this unchanged, which is what keeps the tool layer provider-agnostic.
 */
export function sandboxProviderContract(
  name: string,
  makeProvider: () => SandboxProvider,
): void {
  describe(`${name} sandbox provider contract`, () => {
    it("reports healthy with the protocol version", async () => {
      const health = await makeProvider().health();
      expect(health.ok).toBe(true);
      expect(health.protocol).toBe(1);
    });

    it("runs a command and returns its exit code and output", async () => {
      const result = await makeProvider().run("printf contract; exit 4");
      expect(result.stdout).toBe("contract");
      expect(result.exitCode).toBe(4);
      expect(result.timedOut).toBe(false);
    });

    it("round-trips bytes through readFile and writeFile", async () => {
      const provider = makeProvider();
      const bytes = new Uint8Array([0, 255, 1, 254]);
      await provider.writeFile("/tmp/contract.bin", bytes);
      expect(await provider.readFile("/tmp/contract.bin", 1024)).toEqual(bytes);
    });

    it("refuses a read above the caller's limit", async () => {
      const provider = makeProvider();
      await provider.writeFile("/tmp/contract-big.bin", new Uint8Array(2048));
      await expect(
        provider.readFile("/tmp/contract-big.bin", 1024),
      ).rejects.toMatchObject({ code: "TOO_LARGE" });
    });

    it("surfaces a missing file as NOT_FOUND", async () => {
      await expect(
        makeProvider().readFile("/tmp/contract-missing.bin", 1024),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
}
