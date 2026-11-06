/** 真实的 8×8 纯色 PNG：Photon 能解码，且符合额度会被原样返回。 */
export const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mM4YWODFTEMLQkAZZlQAS/gME0AAAAASUVORK5CYII=";

export function bytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** A tool API whose agent model takes images only when `vision` is true. */
export const fakeApi = (vision: boolean) =>
  ({
    agent: async () => ({ model: { provider: "p", modelId: "m" } }),
    models: { getModel: () => ({ input: vision ? ["text", "image"] : ["text"] }) },
  }) as never;
