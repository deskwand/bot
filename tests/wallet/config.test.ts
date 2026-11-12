import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { CHAINS, pairKey } from "../../src/wallet/chain";
import { walletConfig } from "../../src/wallet/config";

const PRIVATE_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111";
const OWNER = "0x1234567890abcdef1234567890abcdef12345678";

const base = {
  schemaVersion: 1,
  owner: { telegramUserIds: [] },
  models: {
    butler: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
    task: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
  },
  mcpServers: [],
};

function envWith(
  wallet: unknown,
  secrets: Record<string, string | undefined> = {},
): Env {
  return {
    DESKWAND_CONFIG: wallet === undefined ? base : { ...base, wallet },
    WALLET_PRIVATE_KEY: PRIVATE_KEY,
    WALLET_OWNER_ADDRESS: OWNER,
    ...secrets,
  } as unknown as Env;
}

describe("walletConfig", () => {
  it("defaults the RPC URL when the wallet section is absent", () => {
    const config = walletConfig(envWith(undefined));
    expect(config).not.toBeNull();
    expect(config?.rpcUrl).toBe("https://mainnet.base.org");
    expect(config?.privateKey).toBe(PRIVATE_KEY);
    expect(config?.ownerAddress).toBe(OWNER);
  });

  it("returns null when the private key is missing, without a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      walletConfig(envWith(undefined, { WALLET_PRIVATE_KEY: undefined })),
    ).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns null when the owner address is missing", () => {
    expect(
      walletConfig(envWith(undefined, { WALLET_OWNER_ADDRESS: undefined })),
    ).toBeNull();
  });

  it("returns null for a 63-character private key", () => {
    expect(
      walletConfig(
        envWith(undefined, {
          WALLET_PRIVATE_KEY: `0x${"1".repeat(63)}`,
        }),
      ),
    ).toBeNull();
  });

  it("returns null for a mixed-case address with a bad checksum", () => {
    expect(
      walletConfig(
        envWith(undefined, {
          WALLET_OWNER_ADDRESS: "0x1234567890Abcdef1234567890abcdef12345678",
        }),
      ),
    ).toBeNull();
  });

  it("returns null for the zero address", () => {
    expect(
      walletConfig(
        envWith(undefined, {
          WALLET_OWNER_ADDRESS: "0x0000000000000000000000000000000000000000",
        }),
      ),
    ).toBeNull();
  });

  it("returns null when the owner is the wallet itself", () => {
    const address = privateKeyToAccount(PRIVATE_KEY).address;
    expect(
      walletConfig(envWith(undefined, { WALLET_OWNER_ADDRESS: address })),
    ).toBeNull();
  });

  it("returns null for a non-https RPC URL", () => {
    expect(
      walletConfig(envWith({ rpcUrl: "http://mainnet.base.org" })),
    ).toBeNull();
  });

  it("never logs the private key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = walletConfig(
        envWith(undefined, { WALLET_PRIVATE_KEY: "0xdeadbeef" }),
      );
      expect(result).toBeNull();
      expect(warn).toHaveBeenCalled();
      const logged = warn.mock.calls.flat().map(String).join(" ");
      expect(logged).not.toContain("0xdeadbeef");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("pairKey", () => {
  it("ignores the argument order", () => {
    expect(pairKey("WETH", "USDC")).toBe(pairKey("USDC", "WETH"));
  });
});

describe("CHAINS", () => {
  it("records the USDC/WETH fee tier on Base", () => {
    expect(CHAINS.base.feeTier[pairKey("USDC", "WETH")]).toBe(3000);
  });
});
