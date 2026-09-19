import { readStoredPreference } from "../stored-preference";

/**
 * Which half of the roster a person is working in.
 *
 * OwnBot is everything by default. Cowork is the coding cockpit, and it holds the conversations of the
 * coworkers a person has named as their coding agents.
 *
 * IT WAS DERIVED, AND THAT WAS WRONG. The first version read the split off how each coworker runs:
 * ACP meant a CLI, a CLI meant a coding agent. The argument was that a mode nobody has to configure
 * cannot sit there empty. On a deployment where the operator maps every coworker to a CLI — and that
 * is the deployment this was written for, ten of ten on Codex, Claude and Grok — the rule was true of
 * everything, so Cowork swallowed the whole roster and OwnBot went empty. `coord` answering through
 * Codex is not a coding agent; it is an assistant that happens to run on one.
 *
 * Nothing in the operator's mapping distinguishes the two, so nothing derived can. The marks are the
 * person's, and the default is no marks at all: OwnBot holds everything, exactly as it did before
 * there was a switch, until somebody says otherwise.
 */

export type WorkspaceMode = "ownbot" | "cowork";

/** How a coworker runs, as the roster already receives it. */
export type RuntimeKind =
  | "acp"
  | "api"
  | "private_local"
  | "remote"
  | "unavailable";

const MODE_KEY = "ownbot.workspace-mode";
const CODING_KEY = "ownbot.cowork-coworkers";

export function isWorkspaceMode(value: unknown): value is WorkspaceMode {
  return value === "ownbot" || value === "cowork";
}

/**
 * The mode this browser was last left in.
 *
 * Local, and deliberately not on the server: this is which part of their own roster somebody is
 * looking at, not a fact about the deployment or about the conversation. Storage can throw outright
 * in a private window or with site data blocked, so a failed read is the default mode rather than a
 * blank screen.
 */
export function readWorkspaceMode(): WorkspaceMode {
  try {
    const stored = readStoredPreference(MODE_KEY, "openbot.workspace-mode");
    return isWorkspaceMode(stored) ? stored : "ownbot";
  } catch {
    return "ownbot";
  }
}

export function writeWorkspaceMode(mode: WorkspaceMode): void {
  try {
    globalThis.localStorage?.setItem(MODE_KEY, mode);
  } catch {
    // A preference that cannot be written is still honoured for this session; the switch holds it in
    // React state either way. Losing it on reload is a smaller failure than refusing the click.
  }
}

/**
 * The coworkers this person treats as coding agents.
 *
 * Per browser for now, for the same reason the mode is: it decides what somebody sees, not what the
 * runtime does. A turn answers identically whether or not its coworker is marked — no prompt, no
 * session and no model selection reads this. That is what makes a local answer honest here rather
 * than merely convenient, and it is also why moving it to the server later changes no behaviour.
 */
export function readCodingCoworkers(): ReadonlySet<string> {
  try {
    const raw = readStoredPreference(CODING_KEY, "openbot.cowork-coworkers");
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string")
        : [],
    );
  } catch {
    // Unreadable, or not an array: no marks, which is the safe reading. Guessing here would file
    // somebody's conversations under a half they never chose.
    return new Set();
  }
}

export function writeCodingCoworkers(ids: ReadonlySet<string>): void {
  try {
    globalThis.localStorage?.setItem(CODING_KEY, JSON.stringify([...ids]));
  } catch {}
}

/** Add or remove one coworker, returning a new set rather than mutating the old one. */
export function toggleCodingCoworker(
  ids: ReadonlySet<string>,
  agentId: string,
): Set<string> {
  const next = new Set(ids);
  if (!next.delete(agentId)) next.add(agentId);
  return next;
}

/**
 * Where a conversation with this one coworker belongs.
 *
 * Used when the conversation does not exist yet and there is nothing to filter: somebody has picked a
 * recipient, and the roster they are about to be returned to should be the one holding the result.
 */
export function modeForCoworker(
  agentId: string,
  coding: ReadonlySet<string>,
): WorkspaceMode {
  return coding.has(agentId) ? "cowork" : "ownbot";
}

/** Just enough of a channel to place it, so the roster's own type stays the caller's business. */
type PlaceableChannel = { agentIds: string[] };

/**
 * Whether a conversation belongs to the cockpit.
 *
 * Any marked coworker in the channel puts it there, including a channel that also holds an unmarked
 * one: the cockpit is where that coworker's session, workspace and model selection are visible, and a
 * channel holding one of those filed under OwnBot is a channel whose session nobody can see.
 */
export function isCoworkChannel(
  channel: PlaceableChannel,
  coding: ReadonlySet<string>,
): boolean {
  return channel.agentIds.some((agentId) => coding.has(agentId));
}

/**
 * What the switch offers, and which mode is actually in force.
 *
 * `available` asks whether a cockpit is POSSIBLE, not whether it is populated — any coworker on an
 * ACP connection can have one, because that is what gives it a session and a workspace to show. It
 * has to be true before anything is marked, or the door into Cowork would only appear once somebody
 * had already walked through it.
 *
 * `mode` is the effective one, which is not always the stored one. Someone left in Cowork on a
 * deployment that has since lost its ACP coworkers is shown OwnBot rather than an empty cockpit they
 * cannot leave by reloading. An empty Cowork somebody can still fill is not that case: it stays, and
 * says how to fill it.
 */
export function workspaceSwitchView(input: {
  stored: WorkspaceMode;
  channels: readonly PlaceableChannel[] | undefined;
  coding: ReadonlySet<string>;
  /** Whether any coworker in the roster runs over ACP, marked or not. */
  hasAcpCoworker: boolean;
}): {
  mode: WorkspaceMode;
  available: boolean;
  counts: { ownbot: number; cowork: number };
} {
  const available = input.hasAcpCoworker;
  const mode = available ? input.stored : "ownbot";
  const channels = input.channels ?? [];
  let cowork = 0;
  for (const channel of channels) {
    if (isCoworkChannel(channel, input.coding)) cowork += 1;
  }
  return {
    mode,
    available,
    counts: { ownbot: channels.length - cowork, cowork },
  };
}

/**
 * The roster, narrowed to the mode in force.
 *
 * Returns the input array unchanged when nothing is filtered out, for the same reason the search
 * filter does: handing `AnimatePresence` a fresh array identity restages every row, and OwnBot
 * holding everything — which is the default — is not a reason to animate the whole list.
 */
export function channelsForMode<Channel extends PlaceableChannel>(
  mode: WorkspaceMode,
  channels: Channel[] | undefined,
  coding: ReadonlySet<string>,
): Channel[] {
  if (!channels) return [];
  const wanted = channels.filter(
    (channel) => isCoworkChannel(channel, coding) === (mode === "cowork"),
  );
  return wanted.length === channels.length ? channels : wanted;
}
