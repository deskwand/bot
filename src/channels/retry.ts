import { ChannelError } from "./types";
import { ILinkError } from "./wechat/ilink";

export const SEND_ATTEMPTS = 3;
export const SEND_DELAYS_MS = [200, 600, 1800] as const;

/** 4xx 是对这个请求本身的拒绝，重发只会再失败一次。 */
export function isRetryableSend(error: unknown): boolean {
  // iLink 的失败不是 ChannelError；不认出它就会把 CDN 的 4xx 重发三次，
  // 每次都要重新加密并上传整个文件。
  if (error instanceof ILinkError) {
    return error.status === 0 || error.status >= 500;
  }
  if (!(error instanceof ChannelError)) return true;
  return error.status === 0 || error.status >= 500;
}

export async function withRetry<T>(
  run: (attempt: number) => Promise<T>,
  opts: {
    attempts?: number;
    delays?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const attempts = opts.attempts ?? SEND_ATTEMPTS;
  const delays = opts.delays ?? SEND_DELAYS_MS;
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await run(attempt);
    } catch (error) {
      if (!isRetryableSend(error) || attempt === attempts - 1) throw error;
      const delay = delays[Math.min(attempt, delays.length - 1)] ?? 0;
      if (delay > 0) await sleep(delay);
    }
  }
  // attempts >= 1 保证循环内一定会 return 或 throw；这行只为类型完整。
  throw new Error("withRetry requires at least one attempt");
}
