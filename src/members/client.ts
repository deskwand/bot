/**
 * Internal wrappers the server uses when it acts for a member. Tool
 * arguments only ever carry a key; the actor comes from trusted server code,
 * and task ownership is looked up server-side.
 *
 * ChannelDO exposes `resolveMemberAttachment` / `registerTaskArtifact` on top
 * of this client, with the lookup backed by the Butler's task index. The
 * lookup is async on purpose: it is a real RPC, not an in-memory guess, and it
 * never trusts a model-supplied owner.
 */
import { AttachmentAccess } from "./artifact-access";
import { MEMBER_ACCESS_DENIED, MemberError } from "./store";
import type { Principal } from "./principal";

/**
 * The directory could not be reached. Distinct from a denial: a denial means
 * "this channel is gone", this means "ask again later".
 */
export class DirectoryUnavailable extends Error {
  constructor() {
    super("member directory unavailable");
    this.name = "DirectoryUnavailable";
  }
}

export const TASK_NOT_FOUND = "TASK_NOT_FOUND";
export const ARTIFACT_KEY_MISMATCH = "ARTIFACT_KEY_MISMATCH";

export type TaskArtifactScope = {
  taskId: string;
  memberId: string;
  keyPrefix: string;
};

export type TaskArtifactLookup = (
  taskId: string,
) => Promise<TaskArtifactScope | null>;

function keyIsWithin(key: string, prefix: string): boolean {
  if (!key.startsWith(prefix)) return false;
  return !key.split("/").includes("..");
}

export class MemberAccessClient {
  private readonly store: { assertActive(actor: Principal): void };

  private readonly access: AttachmentAccess;

  private readonly lookup: TaskArtifactLookup;

  constructor(
    store: { assertActive(actor: Principal): void },
    access: AttachmentAccess,
    lookup: TaskArtifactLookup,
  ) {
    this.store = store;
    this.access = access;
    this.lookup = lookup;
  }

  /** Resolves an attachment key the actor already owns. */
  resolveMemberAttachment(actor: Principal, key: string): string {
    this.store.assertActive(actor);
    if (!this.access.owns(actor.memberId, key)) {
      throw new MemberError(MEMBER_ACCESS_DENIED);
    }
    return key;
  }

  /**
   * Registers an artifact produced for an existing task. The key must sit
   * under that task's prefix and the actor must own the task.
   */
  async registerTaskArtifact(
    actor: Principal,
    taskId: string,
    key: string,
  ): Promise<void> {
    this.store.assertActive(actor);
    const task = await this.lookup(taskId);
    if (!task) throw new MemberError(TASK_NOT_FOUND);
    if (task.memberId !== actor.memberId) {
      throw new MemberError(MEMBER_ACCESS_DENIED);
    }
    if (!keyIsWithin(key, task.keyPrefix)) {
      throw new MemberError(ARTIFACT_KEY_MISMATCH);
    }
    this.access.record(actor.memberId, key);
  }
}
