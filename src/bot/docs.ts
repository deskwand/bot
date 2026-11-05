export const RULES_DOC = "守则";
export const MEMORY_DOC = "记忆";
export const RULES_LIMIT = 2000;
export const MEMORY_LIMIT = 2200;
export const METHODS_LIMIT = 6000;
export const DOC_NAME_LIMIT = 40;

export type BotDoc = { name: string; content: string };

export type DocWriteCheck =
  | { ok: true; name: string; content: string | null; used: number; limit: number }
  | { ok: false; message: string };

const NAME_ERROR = `文档名需为 1–${DOC_NAME_LIMIT} 字，且不能含换行或 <<< / >>>`;

/** A writable document that is neither the rules nor the memory document. */
export function isMethodDoc(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed.length > 0 && trimmed !== RULES_DOC && trimmed !== MEMORY_DOC
  );
}

/**
 * Validates one document write. `content` is trimmed; blank content deletes.
 * `used` is the total after the write, summed across method documents.
 */
export function checkDocWrite(
  docs: readonly BotDoc[],
  name: string,
  content: string,
  options: { allowRules: boolean },
): DocWriteCheck {
  const trimmedName = name.trim();
  const trimmedContent = content.trim();

  if (
    trimmedName.length === 0 ||
    trimmedName.length > DOC_NAME_LIMIT ||
    trimmedName.includes("\n") ||
    trimmedName.includes("\r") ||
    trimmedName.includes("<<<") ||
    trimmedName.includes(">>>")
  ) {
    return { ok: false, message: NAME_ERROR };
  }

  if (trimmedName === RULES_DOC && !options.allowRules) {
    return {
      ok: false,
      message: `「${RULES_DOC}」不能直接写，请用 propose_rules 提议`,
    };
  }

  const methods = docs.filter((doc) => isMethodDoc(doc.name));
  const methodUsed = methods
    .filter((doc) => doc.name !== trimmedName)
    .reduce((sum, doc) => sum + doc.content.length, 0);

  if (trimmedContent === "") {
    return {
      ok: true,
      name: trimmedName,
      content: null,
      used: isMethodDoc(trimmedName) ? methodUsed : 0,
      limit: limitFor(trimmedName),
    };
  }

  const used = isMethodDoc(trimmedName)
    ? methodUsed + trimmedContent.length
    : trimmedContent.length;
  const limit = limitFor(trimmedName);
  if (used > limit) {
    return {
      ok: false,
      message: `超过上限：写入后 ${used}/${limit} 字，请先精简`,
    };
  }
  return { ok: true, name: trimmedName, content: trimmedContent, used, limit };
}

function limitFor(name: string): number {
  if (name === RULES_DOC) return RULES_LIMIT;
  if (name === MEMORY_DOC) return MEMORY_LIMIT;
  return METHODS_LIMIT;
}
