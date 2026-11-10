export async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error("响应不是 JSON");
  }
}

export function clampCount(max: number, cap: number): number {
  if (Number.isNaN(max)) return 1;
  return Math.min(cap, Math.max(1, Math.trunc(max)));
}
