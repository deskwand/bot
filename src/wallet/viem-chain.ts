import {
  createPublicClient,
  http,
  keccak256,
  WaitForTransactionReceiptTimeoutError,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import {
  CHAINS,
  erc20Abi,
  pairKey,
  quoterV2Abi,
  type ChainConstants,
  type ChainPort,
  type Network,
  type Receipt,
  type Signed,
  type Token,
  type TxRequest,
} from "./chain.ts";
import type { WalletConfig } from "./config.ts";

export type {
  ChainPort,
  Receipt,
  Signed,
  Token,
  TxRequest,
} from "./chain.ts";

function makeClient(config: WalletConfig, network: Network) {
  return createPublicClient({
    chain: network === "base" ? base : baseSepolia,
    transport: http(config.rpcUrl),
  });
}

type Client = ReturnType<typeof makeClient>;

/** The production chain port: nowhere else may touch viem transactions. */
export class ViemChain implements ChainPort {
  readonly address: Address;
  private readonly account: PrivateKeyAccount;
  private readonly client: Client;
  private readonly constants: ChainConstants;

  constructor(config: WalletConfig, network: Network) {
    this.constants = CHAINS[network];
    this.account = privateKeyToAccount(config.privateKey);
    this.address = this.account.address;
    this.client = makeClient(config, network);
  }

  async ethBalance(): Promise<bigint> {
    return this.client.getBalance({ address: this.address });
  }

  async tokenBalance(token: Token): Promise<bigint> {
    return this.client.readContract({
      address: this.token(token).address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.address],
    });
  }

  async quote(sell: Token, buy: Token, amountIn: bigint): Promise<bigint> {
    const key = pairKey(sell, buy);
    const fee = this.constants.feeTier[key];
    if (fee === undefined) throw new Error(`no fee tier for ${key}`);
    const { result } = await this.client.simulateContract({
      address: this.constants.quoter,
      abi: quoterV2Abi,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: this.token(sell).address,
          tokenOut: this.token(buy).address,
          amountIn,
          fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    return result[0];
  }

  async sign(tx: TxRequest): Promise<Signed> {
    // The latest (mined) nonce, not the pending one: a transfer stuck in the
    // mempool and given up on by reconciliation then shares its nonce with
    // the next one, so at most one of the two can ever be mined.
    const nonce = await this.nonce();
    const request = await this.client.prepareTransactionRequest({
      account: this.account,
      to: tx.to,
      data: tx.data,
      value: 0n,
      nonce,
      type: "eip1559",
    });
    const raw = await this.account.signTransaction(request);
    return { hash: keccak256(raw), raw, nonce };
  }

  async nonce(): Promise<number> {
    return this.client.getTransactionCount({
      address: this.address,
      blockTag: "latest",
    });
  }

  async broadcast(raw: Hex): Promise<void> {
    await this.client.sendRawTransaction({ serializedTransaction: raw });
  }

  async receipt(hash: Hex, timeoutMs: number): Promise<Receipt | null> {
    try {
      const receipt = await this.client.waitForTransactionReceipt({
        hash,
        timeout: timeoutMs,
      });
      // A same-nonce replacement means our transaction will never land.
      if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
        return null;
      }
      return {
        status: receipt.status,
        gasWei: receipt.gasUsed * receipt.effectiveGasPrice,
      };
    } catch (error) {
      if (error instanceof WaitForTransactionReceiptTimeoutError) return null;
      throw error;
    }
  }

  private token(token: Token): { address: Address; decimals: number } {
    const entry = this.constants.tokens[token];
    if (entry === undefined) {
      throw new Error(`token ${token} is not available on this network`);
    }
    return entry;
  }
}
