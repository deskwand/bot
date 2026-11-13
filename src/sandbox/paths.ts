import { normalizePath, workspacePrefix } from "../env/r2-env";

/** `/report.csv` → `work/<taskId>/report.csv`, using the existing draft layout. */
export function sandboxPathFromDraft(taskId: string, draftPath: string): string {
  const resolved = normalizePath(draftPath);
  if (!resolved.ok) throw new Error(resolved.error.message);
  return workspacePrefix(taskId) + resolved.value.slice(1);
}
