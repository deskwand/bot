/**
 * A manual smoke test for the wallet on Base Sepolia. Not part of CI.
 *
 * Usage:
 *   node --use-env-proxy --experimental-strip-types scripts/wallet-sepolia.ts --dry-run --random-key
 *   node --use-env-proxy --experimental-strip-types scripts/wallet-sepolia.ts --swap --dry-run --random-key
 *   WALLET_PRIVATE_KEY=0x... WALLET_OWNER_ADDRESS=0x... \
 *     node --use-env-proxy --experimental-strip-types scripts/wallet-sepolia.ts
 *
 * `SEPOLIA_RPC_URL` overrides the public RPC. `--dry-run` signs without
 * broadcasting. `--random-key` uses a throwaway key (and, when no owner is
 * set, a throwaway owner) so a dry run needs neither secret. `--swap` swaps
 * 1 USDC into WETH instead of transferring; a real swap needs at least 5 USDC
 * in the wallet (the trading floor) and 0.002 ETH for gas.
 */
import {
  formatEther,
  formatUnits,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CHAINS, pairKey } from "../src/wallet/chain.ts";
import {
  checkRemit,
  checkSwap,
  MIN_REMIT_USD,
  minOut,
  RECEIPT_TIMEOUT_MS,
} from "../src/wallet/guard.ts";
import {
  approveTx,
  assertAllowedTarget,
  swapTx,
  transferTx,
} from "../src/wallet/tx.ts";
import { ViemChain } from "../src/wallet/viem-chain.ts";

const DEFAULT_RPC_URL = "https://sepolia.base.org";
const ONE_USDC = 1_000_000n;
// The guard refuses anything below MIN_REMIT_USD, so the smoke transfer uses
// the smallest amount the wallet itself would ever send.
const TRANSFER_USDC = BigInt(MIN_REMIT_USD);

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

/** Only the host is safe to print: the URL may carry an API key. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid url";
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    fail(`请设置环境变量 ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const randomKey = args.has("--random-key");

  const privateKey = randomKey
    ? generatePrivateKey()
    : required("WALLET_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    fail("WALLET_PRIVATE_KEY 格式不对：需要 0x 加 64 位 hex");
  }

  let ownerValue = process.env.WALLET_OWNER_ADDRESS?.trim();
  if ((ownerValue === undefined || ownerValue === "") && randomKey) {
    ownerValue = privateKeyToAccount(generatePrivateKey()).address;
  }
  if (ownerValue === undefined || ownerValue === "") {
    fail("请设置环境变量 WALLET_OWNER_ADDRESS");
  }
  if (!isAddress(ownerValue)) {
    fail("WALLET_OWNER_ADDRESS 不是合法地址");
  }
  const owner = ownerValue as Address;

  const rpcUrl = process.env.SEPOLIA_RPC_URL?.trim() || DEFAULT_RPC_URL;
  const network = CHAINS["base-sepolia"];
  const chain = new ViemChain(
    { privateKey: privateKey as Hex, ownerAddress: owner, rpcUrl },
    "base-sepolia",
  );

  console.log("network: base-sepolia (chainId", network.chainId, ")");
  console.log("rpc host:", hostOf(rpcUrl));
  console.log("wallet:", chain.address);
  console.log("owner:", owner);

  const eth = await chain.ethBalance();
  console.log("ETH:", formatEther(eth));
  const usdc = await chain.tokenBalance("USDC");
  console.log("USDC:", formatUnits(usdc, 6));

  const wethOut = await chain.quote("USDC", "WETH", ONE_USDC);
  console.log("quote: 1 USDC ->", formatUnits(wethOut, 18), "WETH");

  if (args.has("--swap")) {
    const feeTier = network.feeTier[pairKey("USDC", "WETH")];
    if (feeTier === undefined) fail("Sepolia 上没有 USDC/WETH 的费率档");

    const amountIn = ONE_USDC;
    const minimum = minOut(wethOut);
    const approve = approveTx(network, "USDC", amountIn);
    const swap = swapTx(
      network,
      chain.address,
      "USDC",
      "WETH",
      amountIn,
      minimum,
      feeTier,
    );
    assertAllowedTarget(network, approve);
    assertAllowedTarget(network, swap);

    console.log("approve to:", approve.to);
    console.log("swap to:", swap.to);
    console.log("minOut:", formatUnits(minimum, 18), "WETH");

    const weth = await chain.tokenBalance("WETH");
    const wethUsd = weth > 0n ? await chain.quote("WETH", "USDC", weth) : 0n;
    const check = checkSwap({
      sell: "USDC",
      buy: "WETH",
      amountIn,
      amountInUsd: Number(amountIn) / 1e6,
      holdings: {
        ethWei: eth,
        tokens: { USDC: usdc, WETH: weth, cbBTC: 0n },
        valueUsd: Number(usdc + wethUsd) / 1e6,
      },
      realizedLossUsd: 0,
      feeTier,
      whitelisted: true,
    });
    if (check !== null) {
      console.log("checkSwap 拒绝:", check);
      return;
    }
    console.log("checkSwap 通过");

    if (dryRun) {
      console.log("--dry-run：不签名也不广播");
      return;
    }

    const allowance = await chain.allowance("USDC", network.router);
    if (allowance < amountIn) {
      const signedApprove = await chain.sign(approve);
      await chain.broadcast(signedApprove.raw);
      console.log("broadcast approve:", signedApprove.hash);
      const approveReceipt = await chain.receipt(
        signedApprove.hash,
        RECEIPT_TIMEOUT_MS,
      );
      console.log(
        "approve receipt:",
        approveReceipt === null ? "超时仍未上链" : approveReceipt.status,
      );
      if (approveReceipt?.status !== "success") return;
    }

    const signed = await chain.sign(swap);
    await chain.broadcast(signed.raw);
    console.log("broadcast:", signed.hash);

    const receipt = await chain.receipt(signed.hash, RECEIPT_TIMEOUT_MS);
    console.log(
      "receipt:",
      receipt === null ? "超时仍未上链" : receipt.status,
    );
    return;
  }

  const amount = TRANSFER_USDC * ONE_USDC;
  const tx = transferTx(network, owner, amount);
  console.log(
    "transfer:",
    formatUnits(amount, 6),
    "USDC ->",
    owner,
    "via",
    tx.to,
  );
  assertAllowedTarget(network, tx);

  const check = checkRemit(amount, usdc);
  if (check !== null) {
    console.log("checkRemit 拒绝:", check);
    return;
  }

  const signed = await chain.sign(tx);
  console.log("signed:", signed.hash);
  if (dryRun) {
    console.log("--dry-run：已签名，不广播");
    return;
  }

  await chain.broadcast(signed.raw);
  console.log("broadcast:", signed.hash);

  const receipt = await chain.receipt(signed.hash, RECEIPT_TIMEOUT_MS);
  console.log(
    "receipt:",
    receipt === null ? "超时仍未上链" : receipt.status,
  );
}

try {
  await main();
} catch (error) {
  // A viem error may echo the RPC URL; only the class name is safe.
  console.error(
    "失败:",
    error instanceof Error ? error.constructor.name : "Error",
  );
  process.exitCode = 1;
}
