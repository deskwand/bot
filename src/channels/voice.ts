/**
 * 语音转写：把一段音频字节交给 Workers AI 的 Whisper，返回文字。
 *
 * 任何失败都返回 `undefined`，由调用方降级成 `voiceFailed`——一条听不懂的
 * 语音不该让整条消息失败。
 */

/** 转写只用到 Workers AI binding 的这一部分，测试注入 fake。 */
export type VoiceAi = {
  run(
    model: string,
    inputs: { audio: string },
  ): Promise<{ text?: string } | undefined>;
};

/** 基础 `whisper` 要 `number[]`，turbo 要 base64 字符串，不要混用。 */
export const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 分块 btoa：整块 spread 一个 Uint8Array 会爆栈。 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let binary = "";
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

export async function transcribeVoice(
  bytes: Uint8Array,
  ai: VoiceAi | undefined,
): Promise<string | undefined> {
  if (!ai) {
    console.error("voice: AI binding is missing, cannot transcribe");
    return undefined;
  }
  if (bytes.byteLength === 0) return undefined;

  try {
    const result = await ai.run(WHISPER_MODEL, { audio: toBase64(bytes) });
    const text = result?.text?.trim();
    return text ? text : undefined;
  } catch (error) {
    console.error(`voice: transcription failed: ${errorMessage(error)}`);
    return undefined;
  }
}
