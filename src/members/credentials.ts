/**
 * Backend-only credential storage. WeChat tokens live here, under a reserved
 * prefix, never in SQL and never behind a model-facing tool.
 *
 * Every activation stages a *new* key: the caller never gets to reuse a key
 * that is already live, and the staged record in SQL is what makes a crash
 * between the KV write and the pointer move recoverable.
 */
export const PRIVATE_WECHAT_PREFIX = "private:wechat:";

/**
 * Vault key for one invitation's raw binding token. The directory keeps only
 * the digest; cancelling or consuming the invite deletes this key.
 */
export function inviteTokenKey(inviteId: string): string {
  return `invite:${inviteId}`;
}

/** Candidate keys carry this marker so an orphan is recognisable. */
export const CREDENTIAL_STAGING_PREFIX = "staging:";

const STAGING_TABLE = `CREATE TABLE IF NOT EXISTS credential_staging (
  key TEXT PRIMARY KEY,
  base_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`;

export class CredentialVault {
  private readonly storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
  }

  async put(key: string, value: unknown): Promise<void> {
    await this.storage.put(this.fullKey(key), value);
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.storage.get<T>(this.fullKey(key));
  }

  async delete(key: string): Promise<void> {
    await this.storage.delete(this.fullKey(key));
  }

  private fullKey(key: string): string {
    return key.startsWith(PRIVATE_WECHAT_PREFIX)
      ? key
      : `${PRIVATE_WECHAT_PREFIX}${key}`;
  }
}

/**
 * staged -> active, with durable bookkeeping:
 *
 * 1. allocate a unique candidate key and persist its staging row,
 * 2. save the credential under that candidate,
 * 3. run the synchronous activation, which moves the `credential_key` pointer,
 * 4. commit (drop the staging row) or discard (delete the candidate only
 *    when no connection points at it, and only drop its staging row once that
 *    delete succeeded, so a failed cleanup is retried on the next boot).
 *
 * `reconcile` runs on startup: any candidate that no connection references is
 * an interrupted operation and is deleted. A referenced candidate is live and
 * is never touched.
 */
export class CredentialStaging {
  private readonly sql: SqlStorage;

  private readonly vault: CredentialVault;

  private readonly now: () => number;

  constructor(
    sql: SqlStorage,
    vault: CredentialVault,
    now: () => number = () => Date.now(),
  ) {
    this.sql = sql;
    this.vault = vault;
    this.now = now;
    this.sql.exec(STAGING_TABLE);
  }

  /** Stages a credential under a key nobody else can be using. */
  async stage(baseKey: string, value: unknown): Promise<string> {
    const candidate =
      `${baseKey}${CREDENTIAL_STAGING_PREFIX}` +
      crypto.randomUUID().replace(/-/g, "");
    this.sql.exec(
      `INSERT INTO credential_staging (key, base_key, created_at)
       VALUES (?, ?, ?)`,
      candidate,
      baseKey,
      this.now(),
    );
    try {
      await this.vault.put(candidate, value);
    } catch (error) {
      this.sql.exec(`DELETE FROM credential_staging WHERE key = ?`, candidate);
      throw error;
    }
    return candidate;
  }

  /** The candidate became the live pointer. */
  commit(candidate: string): void {
    this.sql.exec(`DELETE FROM credential_staging WHERE key = ?`, candidate);
  }

  /**
   * Activation failed: forget the candidate unless something now points at it.
   *
   * The staging row is the only record that lets a later boot find an unused
   * secret, so it goes last: a referenced candidate keeps its value and only
   * drops the bookkeeping, while an unreferenced one is deleted first and
   * only forgotten once that delete succeeded. If the delete fails the row
   * survives, so `reconcile` on the next boot retries it.
   */
  async discard(candidate: string): Promise<void> {
    if (this.isReferenced(candidate)) {
      this.sql.exec(`DELETE FROM credential_staging WHERE key = ?`, candidate);
      return;
    }
    await this.vault.delete(candidate);
    this.sql.exec(`DELETE FROM credential_staging WHERE key = ?`, candidate);
  }

  /** Restart recovery: delete every candidate that is not a live pointer. */
  async reconcile(): Promise<string[]> {
    const rows = this.sql
      .exec<{ key: string }>(`SELECT key FROM credential_staging`)
      .toArray();
    const removed: string[] = [];
    for (const row of rows) {
      if (!this.isReferenced(row.key)) {
        await this.vault.delete(row.key);
        removed.push(row.key);
      }
      this.sql.exec(`DELETE FROM credential_staging WHERE key = ?`, row.key);
    }
    return removed;
  }

  private isReferenced(key: string): boolean {
    try {
      return (
        this.sql
          .exec(
            `SELECT 1 FROM member_connections WHERE credential_key = ?
             LIMIT 1`,
            key,
          )
          .toArray().length > 0
      );
    } catch {
      return false;
    }
  }
}

/**
 * staged -> active for one operation. The activation receives the allocated
 * candidate key so the caller cannot accidentally point the directory at a
 * key it did not stage.
 */
export async function stageCredentialAndActivate<T>(
  staging: Pick<CredentialStaging, "stage" | "commit" | "discard">,
  baseKey: string,
  value: unknown,
  activate: (candidateKey: string) => T,
): Promise<T> {
  const candidate = await staging.stage(baseKey, value);
  let result: T;
  try {
    result = activate(candidate);
  } catch (error) {
    try {
      await staging.discard(candidate);
    } catch {
      // Cleanup failed, so the staging row is still there and the next boot's
      // reconcile retries the delete; the activation failure is what the
      // caller needs to see.
    }
    throw error;
  }
  staging.commit(candidate);
  return result;
}
