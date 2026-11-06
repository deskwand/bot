/**
 * 产物能被任一渠道送达的容量上限。Telegram 上传文件 50MB、图片 10MB，
 * 微信 iLink 实测约 20MB；15MB 让三者都留余量，也让 Worker 内存可控。
 */
export const MAX_ARTIFACT_BYTES = 15 << 20;

const INVALID_SEGMENT_CHARS = /[/\\\x00-\x1f\x7f]/;

/**
 * 把产物的 R2 key 拆成三段（taskId / fileId / name）。
 * 返回 null 表示这不是一个合法的产物 key。
 */
export function artifactKeySegments(key: string): string[] | null {
  const segments = key.split("/");
  if (segments.length !== 3) return null;
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return null;
    if (INVALID_SEGMENT_CHARS.test(segment)) return null;
  }
  return segments;
}

/** 产物对主人显示的名字就是 key 的最后一段。 */
export function artifactNameFromKey(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}
