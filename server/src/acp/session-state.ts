import { createHash, randomUUID } from "node:crypto";
import { chmod, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AcpProfile } from "./config";
import type { AcpProvider } from "./permissions";

/**
 * Who a conversation belongs to, and nothing else.
 *
 * This hash used to fold the whole operator profile in alongside the owner, the Bot and the thread.
 * A profile carries the model, so choosing a different model produced a different hash, and the hash
 * is the workspace directory. Selecting `gpt-5.1-codex` over `gpt-5.1-codex-mini` therefore moved the
 * working directory, orphaned the last one, and threw away the resume anchor with it: the next turn
 * opened a fresh ACP session in an empty folder and the CLI had never heard of the thread it was being
 * asked to continue.
 *
 * Identity is who is talking. Selection is which CLI and model answers. They are separate values on
 * purpose, and only the identity belongs in a directory name.
 */
export type SessionIdentity = {
  ownerId: string;
  agentId: string;
  threadId: string;
};

/** Which CLI answers, and with which model. Mutable within one persistent session. */
export type SessionSelection = {
  profileId: string;
  provider: AcpProvider;
  model: string | null;
};

/**
 * Why a run did not continue the stored session.
 *
 * A fresh session is not an anomaly to hide. Every one of these reaches the audit trail, because a
 * conversation that quietly restarted and kept answering looks exactly like a conversation that never
 * restarted, and only one of those has its full history in front of the model.
 */
export type FreshReason =
  /** No anchor yet; the first turn in this conversation. */
  | "first_turn"
  /** The adapter does not advertise `loadSession`. */
  | "load_unsupported"
  /** The stored anchor is dead: the CLI refused the load. */
  | "anchor_dead"
  /** The anchor belongs to another CLI, so this one cannot open it. */
  | "provider_changed"
  /**
   * The anchor belongs to another model.
   *
   * One ACP session answers with one model. That is existing behaviour with a good reason behind it:
   * retuning a live session under a person mid-conversation means the earlier half of the thread was
   * answered by a model the interface no longer names. So the model moves the session, and what this
   * change moved is the workspace, which stays put and keeps the files and the history re-seeded.
   */
  | "model_changed"
  /** The stored record could not be read or did not parse. */
  | "record_unreadable"
  /** The person asked to start over. */
  | "requested";

const providerNames: readonly AcpProvider[] = ["codex", "claude", "grok", "pi"];
const freshReasons: readonly FreshReason[] = [
  "first_turn",
  "load_unsupported",
  "anchor_dead",
  "provider_changed",
  "model_changed",
  "record_unreadable",
  "requested",
];

/** A session record is a handful of identifiers. Anything larger is not this file. */
const MAX_STATE_BYTES = 16 * 1024;

const identifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  !value.includes("\0");

const nullableText = (value: unknown): value is string | null =>
  value === null || identifier(value);

export type AcpSessionState = {
  version: 2;
  /** The ACP anchor. Null once cleared, which is what makes the next turn open fresh. */
  sessionId: string | null;
  /** False after a deliberate restart, until a turn completes and re-anchors. */
  resumable: boolean;
  selection: SessionSelection;
  lastMessageId: string | null;
  /**
   * Every text message this session has produced, and the last one on its own.
   *
   * `replyMessageId` is redundant with the tail of `replyMessageIds` by design. A rollback to the
   * previous build reads it, and a record that a rolled-back build cannot read is a conversation that
   * restarts on rollback for no reason. One field buys that back.
   */
  replyMessageId?: string;
  replyMessageIds: string[];
  updatedAt: string;
};

/** The identity half of the key: stable across every model, mode and provider change. */
export function sessionIdentityKey(identity: SessionIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify([identity.ownerId, identity.agentId, identity.threadId]),
    )
    .digest("hex");
}

/**
 * The workspace directory key this code used before identity and selection were separated.
 *
 * Live deployments hold anchors under this name. It is computed, not guessed, so an existing anchor and
 * the files beside it are adopted rather than orphaned on the first turn after this ships. If the shape
 * ever stops matching, the consequence is that a conversation opens fresh, which is precisely what it
 * does today on every model change.
 */
export function legacySessionKey(
  identity: SessionIdentity,
  profile: AcpProfile,
): string {
  return createHash("sha256")
    .update(JSON.stringify([identity.ownerId, identity.agentId, identity.threadId, profile]))
    .digest("hex");
}

/**
 * Where this conversation's workspace is, preferring the directory that already holds its history.
 *
 * Renaming the workspace to the new identity key would have moved the anchor and left behind whatever
 * the last turn wrote. So the old directory wins when it exists, and only new conversations land on the
 * new key. Nothing is copied, nothing is deleted, and the choice is reported so the adoption is auditable
 * rather than something that merely appeared to work.
 */
export async function resolveWorkspaceDirectory(input: {
  workspaceRoot: string;
  identityKey: string;
  legacyKey: string;
  exists: (directory: string) => Promise<boolean>;
}): Promise<{ directory: string; migrated: boolean }> {
  const current = join(input.workspaceRoot, input.identityKey);
  const legacy = join(input.workspaceRoot, input.legacyKey);
  if (await input.exists(current)) return { directory: current, migrated: false };
  if (await input.exists(legacy)) return { directory: legacy, migrated: true };
  return { directory: current, migrated: false };
}

/** The selection an operator profile implies for this turn, before any per-conversation override. */
export function selectionFromProfile(profile: AcpProfile): SessionSelection {
  return {
    profileId: profile.profileId,
    provider: profile.provider ?? "codex",
    model: typeof profile.model === "string" && profile.model ? profile.model : null,
  };
}

function isProvider(value: unknown): value is AcpProvider {
  return providerNames.includes(value as AcpProvider);
}

/**
 * Read a stored record, or say why there is not one to resume.
 *
 * A missing file is the normal first turn. A file that exists and does not parse is not: the previous
 * turn anchored a session somebody wrote down, and losing that means the model is answering without the
 * history it had. Both open fresh; only one of them reports a problem, and the caller audits the one
 * that reports.
 */
export function parseSessionState(
  raw: string | null,
  current: SessionSelection,
): { state: AcpSessionState | undefined; freshReason: FreshReason | undefined } {
  if (raw === null) return { state: undefined, freshReason: undefined };
  let parsed: unknown;
  try {
    if (Buffer.byteLength(raw, "utf8") > MAX_STATE_BYTES)
      return { state: undefined, freshReason: "record_unreadable" };
    parsed = JSON.parse(raw);
  } catch {
    return { state: undefined, freshReason: "record_unreadable" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { state: undefined, freshReason: "record_unreadable" };
  const value = parsed as Record<string, unknown>;
  // The v1 record is the shape every live workspace already holds: an anchor and a cursor, with no
  // selection. It resumes under the operator's current selection rather than being discarded.
  if (value.version !== 2) {
    if (!nullableText(value.sessionId) || !nullableText(value.lastMessageId))
      return { state: undefined, freshReason: "record_unreadable" };
    const replies = Array.isArray(value.replyMessageIds)
      ? value.replyMessageIds.filter(identifier)
      : [];
    const legacy = identifier(value.replyMessageId) ? value.replyMessageId : undefined;
    return {
      state: {
        version: 2,
        sessionId: value.sessionId,
        resumable: value.sessionId !== null,
        selection: current,
        lastMessageId: value.lastMessageId,
        ...(legacy ? { replyMessageId: legacy } : {}),
        replyMessageIds: [...new Set(legacy ? [...replies, legacy] : replies)],
        updatedAt: new Date().toISOString(),
      },
      freshReason: undefined,
    };
  }
  const selection = value.selection as Record<string, unknown> | undefined;
  if (
    !nullableText(value.sessionId) ||
    typeof value.resumable !== "boolean" ||
    !nullableText(value.lastMessageId) ||
    !Array.isArray(value.replyMessageIds) ||
    !value.replyMessageIds.every(identifier) ||
    !(value.replyMessageId === undefined || identifier(value.replyMessageId)) ||
    !selection ||
    typeof selection !== "object" ||
    !identifier(selection.profileId) ||
    !isProvider(selection.provider) ||
    !nullableText(selection.model)
  )
    return { state: undefined, freshReason: "record_unreadable" };
  return {
    state: {
      version: 2,
      sessionId: value.sessionId,
      resumable: value.resumable,
      selection: {
        profileId: selection.profileId,
        provider: selection.provider,
        model: selection.model,
      },
      lastMessageId: value.lastMessageId,
      ...(identifier(value.replyMessageId)
        ? { replyMessageId: value.replyMessageId }
        : {}),
      replyMessageIds: [...new Set(value.replyMessageIds as string[])],
      updatedAt: identifier(value.updatedAt)
        ? value.updatedAt
        : new Date().toISOString(),
    },
    freshReason: undefined,
  };
}

/**
 * Serialize a record for disk.
 *
 * Identifiers and a timestamp only. A record that grew past the limit is not a session anchor any more,
 * it is somebody's transcript, and a transcript does not live next to the workspace of a CLI that may be
 * reading the folder.
 */
export function serializeSessionState(state: AcpSessionState): string {
  const json = JSON.stringify({ ...state, version: 2 });
  if (Buffer.byteLength(json, "utf8") > MAX_STATE_BYTES)
    throw new Error("ACP session record exceeds its size limit");
  return `${json}\n`;
}

/**
 * Write the anchor in place, atomically.
 *
 * The rename is what makes a crash survivable: a half-written anchor is worse than no anchor, because it
 * parses as somebody's real session and then fails to load forever.
 */
export async function writeSessionState(
  file: string,
  state: AcpSessionState,
): Promise<void> {
  const data = serializeSessionState(state);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
  try {
    // Renaming onto an existing file keeps that file's mode, so a v1 record written 0644 would survive
    // this write still world-readable. Tighten the temporary first, then move it.
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } finally {
    // Rename consumes the temporary on success; only a failed rename leaves it behind.
    await rm(temporary, { force: true });
  }
  const mode = (await stat(file)).mode & 0o777;
  if (mode !== 0o600) throw new Error("ACP session record is not owner-only");
}

export type SessionAnchorPlan = {
  /** Open `session/load` against this anchor instead of `session/new`. */
  load: boolean;
  /** The anchor being continued, when `load`. */
  sessionId?: string;
  /** Why the run opens a session instead of continuing one. */
  freshReason?: FreshReason;
  /** The selection carried by the stored anchor, for provider-change detection. */
  storedSelection?: SessionSelection;
  /** Index of the first message the CLI has not already been given. */
  fromIndex: number;
  /** Identifiers the CLI already produced, so they are not replayed as new output. */
  previousReplyIds: ReadonlySet<string>;
};

/**
 * Decide whether this turn continues a session, and what it must not resend.
 *
 * The provider is part of the anchor in fact, even though it is not part of the directory: a Codex
 * session id means nothing to Claude Code. Carrying the selection in the record is what lets a provider
 * switch open a clean session rather than hand a foreign anchor to a CLI that would reject it.
 */
export function planSessionAnchor(input: {
  state: AcpSessionState | undefined;
  unreadable: boolean;
  loadSupported: boolean;
  selection: SessionSelection;
  messages: readonly { id: string }[];
  restartRequested: boolean;
}): SessionAnchorPlan {
  /**
   * A session that never happened has produced nothing.
   *
   * Every fresh path returns this. The alternative was a plan that said "new session" while also
   * carrying the identifiers of answers it had supposedly already seen, and the only thing keeping that
   * honest was the caller remembering to check `fromIndex` first. The invariant belongs in the plan.
   */
  const fresh = (freshReason: FreshReason): SessionAnchorPlan => ({
    load: false,
    freshReason,
    fromIndex: 0,
    previousReplyIds: new Set<string>(),
  });
  if (input.restartRequested) return fresh("requested");
  if (input.unreadable) return fresh("record_unreadable");
  const stored = input.state;
  if (!stored || !stored.sessionId || !stored.resumable)
    return fresh("first_turn");
  if (!input.loadSupported) return fresh("load_unsupported");
  if (
    stored.selection &&
    (stored.selection.provider !== input.selection.provider ||
      stored.selection.profileId !== input.selection.profileId)
  )
    return fresh("provider_changed");
  // One model per session, as before. The difference is the workspace: the new session opens beside
  // the old one, in the same folder, with ownbot's history re-seeded into it.
  if (stored.selection && stored.selection.model !== input.selection.model)
    return fresh("model_changed");
  const cursor = input.messages.findIndex(
    (message) => message.id === stored.lastMessageId,
  );
  if (cursor < 0) return fresh("anchor_dead");
  return {
    load: true,
    sessionId: stored.sessionId,
    storedSelection: stored.selection,
    fromIndex: cursor + 1,
    previousReplyIds: new Set(stored.replyMessageIds),
  };
}
