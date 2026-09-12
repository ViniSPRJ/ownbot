/**
 * Which half of the roster a person is working in.
 *
 * Ownbot is the assistant surface: coworkers that answer through the API, a hosted endpoint, or the
 * private local runtime. Cowork is the coding cockpit: coworkers that run a CLI over ACP, which is
 * the only kind that has a session on disk, a workspace directory, and a model that can be chosen
 * for one conversation.
 *
 * The split is read off how each coworker runs, never off a new flag somebody has to set. A mode a
 * person must configure before it contains anything is a mode that stays empty, and a second column
 * saying "this one is a coding agent" would be a second place to disagree with the operator's ACP
 * mapping about what a coworker actually is.
 */

export type WorkspaceMode = "ownbot" | "cowork";

/** How a coworker runs, as the roster already receives it. */
export type RuntimeKind =
  | "acp"
  | "api"
  | "private_local"
  | "remote"
  | "unavailable";

const STORAGE_KEY = "openbot.workspace-mode";

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
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isWorkspaceMode(stored) ? stored : "ownbot";
  } catch {
    return "ownbot";
  }
}

export function writeWorkspaceMode(mode: WorkspaceMode): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, mode);
  } catch {
    // A preference that cannot be written is still honoured for this session; the switch holds it in
    // React state either way. Losing it on reload is a smaller failure than refusing the click.
  }
}

/** Just enough of a channel to place it, so the roster's own type stays the caller's business. */
type PlaceableChannel = { agentIds: string[] };

/**
 * Whether a conversation belongs to the cockpit.
 *
 * Any ACP coworker in the channel puts it there, including a channel that also holds an API one. The
 * cockpit is where a CLI session, its workspace and its model selection are visible, so a channel
 * that has one of those and is filed under Ownbot is a channel whose session nobody can see.
 *
 * A coworker whose runtime is unknown to the browser — a roster that has not loaded, an id the agent
 * list does not carry — is not ACP as far as this is concerned. Guessing the other way would move
 * conversations into the cockpit every time the agents query is in flight.
 */
export function isCoworkChannel(
  channel: PlaceableChannel,
  runtimeKindOf: (agentId: string) => RuntimeKind | undefined,
): boolean {
  return channel.agentIds.some((agentId) => runtimeKindOf(agentId) === "acp");
}

/**
 * What the switch offers, and which mode is actually in force.
 *
 * `available` is false for a deployment with no ACP coworker at all: there is no cockpit to enter,
 * and offering the door to an empty room is the same lie as an empty dropdown. It turns true on its
 * own the moment the operator maps a CLI to a coworker — nothing here needs to be turned on.
 *
 * `mode` is the effective one, which is not always the stored one. Someone left in Cowork whose last
 * ACP coworker has since been unmapped is shown Ownbot rather than an empty cockpit they cannot leave
 * by reloading.
 */
export function workspaceSwitchView(input: {
  stored: WorkspaceMode;
  channels: readonly PlaceableChannel[] | undefined;
  runtimeKindOf: (agentId: string) => RuntimeKind | undefined;
  /** Whether any coworker in the roster runs over ACP, regardless of having a channel yet. */
  hasCodingCoworker: boolean;
}): {
  mode: WorkspaceMode;
  available: boolean;
  counts: { ownbot: number; cowork: number };
} {
  const available = input.hasCodingCoworker;
  const mode = available ? input.stored : "ownbot";
  const channels = input.channels ?? [];
  let cowork = 0;
  for (const channel of channels) {
    if (isCoworkChannel(channel, input.runtimeKindOf)) cowork += 1;
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
 * filter does: handing `AnimatePresence` a fresh array identity restages every row, and switching
 * into a mode that happens to contain everything is not a reason to animate the whole list.
 */
export function channelsForMode<Channel extends PlaceableChannel>(
  mode: WorkspaceMode,
  channels: Channel[] | undefined,
  runtimeKindOf: (agentId: string) => RuntimeKind | undefined,
): Channel[] {
  if (!channels) return [];
  const wanted = channels.filter(
    (channel) => isCoworkChannel(channel, runtimeKindOf) === (mode === "cowork"),
  );
  return wanted.length === channels.length ? channels : wanted;
}
