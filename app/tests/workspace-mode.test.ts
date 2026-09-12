import { afterEach, describe, expect, test } from "bun:test";
import {
  type RuntimeKind,
  channelsForMode,
  isCoworkChannel,
  modeForCoworker,
  readWorkspaceMode,
  workspaceSwitchView,
  writeWorkspaceMode,
} from "@/lib/workspace/mode";

const runtimes: Record<string, RuntimeKind> = {
  codex: "acp",
  pi: "acp",
  desk: "api",
  relay: "remote",
};
const runtimeKindOf = (agentId: string) => runtimes[agentId];

const channel = (...agentIds: string[]) => ({ agentIds });

describe("placing a conversation in one half of the roster", () => {
  test("a coworker running a CLI puts its conversation in the cockpit", () => {
    expect(isCoworkChannel(channel("codex"), runtimeKindOf)).toBe(true);
    expect(isCoworkChannel(channel("desk"), runtimeKindOf)).toBe(false);
    expect(isCoworkChannel(channel("relay"), runtimeKindOf)).toBe(false);
  });

  test("one coding agent in a mixed channel is enough", () => {
    // The cockpit is where that CLI's session, workspace and model selection can be seen at all.
    // Filing the channel under Ownbot because an API coworker is also in it would hide the only
    // place its session state is visible.
    expect(isCoworkChannel(channel("desk", "pi"), runtimeKindOf)).toBe(true);
  });

  test("a coworker the roster has not loaded yet is not assumed to be a CLI", () => {
    // Guessing the other way would walk conversations into the cockpit on every page load, while
    // the agents query is still in flight, and walk them back out when it lands.
    expect(isCoworkChannel(channel("unknown"), runtimeKindOf)).toBe(false);
    expect(isCoworkChannel(channel(), runtimeKindOf)).toBe(false);
  });
});

describe("what the switch offers", () => {
  const channels = [channel("desk"), channel("codex"), channel("desk", "pi")];

  test("a deployment with no ACP coworker is not offered a cockpit", () => {
    const view = workspaceSwitchView({
      stored: "cowork",
      channels,
      runtimeKindOf,
      hasCodingCoworker: false,
    });
    // And somebody left in Cowork by a coworker that has since been unmapped is shown Ownbot rather
    // than an empty cockpit that a reload cannot get them out of.
    expect(view.available).toBe(false);
    expect(view.mode).toBe("ownbot");
  });

  test("both halves are counted, so each side can say what is on the other", () => {
    const view = workspaceSwitchView({
      stored: "cowork",
      channels,
      runtimeKindOf,
      hasCodingCoworker: true,
    });
    expect(view.available).toBe(true);
    expect(view.mode).toBe("cowork");
    expect(view.counts).toEqual({ ownbot: 1, cowork: 2 });
  });

  test("a roster that has not arrived counts nothing and still offers the switch", () => {
    const view = workspaceSwitchView({
      stored: "ownbot",
      channels: undefined,
      runtimeKindOf,
      hasCodingCoworker: true,
    });
    expect(view.counts).toEqual({ ownbot: 0, cowork: 0 });
    expect(view.available).toBe(true);
  });
});

describe("narrowing the roster to the mode in force", () => {
  test("each mode shows its own conversations and none of the other's", () => {
    const channels = [channel("desk"), channel("codex"), channel("desk", "pi")];
    expect(channelsForMode("ownbot", channels, runtimeKindOf)).toEqual([
      channel("desk"),
    ]);
    expect(channelsForMode("cowork", channels, runtimeKindOf)).toEqual([
      channel("codex"),
      channel("desk", "pi"),
    ]);
  });

  test("filtering nothing out returns the same array, not a copy of it", () => {
    // A fresh array identity restages every animated row. Switching into the mode that happens to
    // hold everything is not a reason to animate the whole list.
    const channels = [channel("codex"), channel("pi")];
    expect(channelsForMode("cowork", channels, runtimeKindOf)).toBe(channels);
    expect(channelsForMode("ownbot", undefined, runtimeKindOf)).toEqual([]);
  });
});

describe("remembering the mode locally", () => {
  const original = globalThis.localStorage;
  const stub = (value: Partial<Storage>) => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value,
    });
  };
  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: original,
    });
  });

  test("a stored mode comes back, and anything else reads as Ownbot", () => {
    const store = new Map<string, string>([
      ["openbot.workspace-mode", "cowork"],
    ]);
    stub({ getItem: (key: string) => store.get(key) ?? null });
    expect(readWorkspaceMode()).toBe("cowork");
    store.set("openbot.workspace-mode", "cockpit");
    expect(readWorkspaceMode()).toBe("ownbot");
    store.delete("openbot.workspace-mode");
    expect(readWorkspaceMode()).toBe("ownbot");
  });

  test("storage that throws is a default, never a blank sidebar", () => {
    // A private window, or a browser with site data blocked, throws on the accessor itself.
    stub({
      getItem: () => {
        throw new Error("site data is blocked");
      },
      setItem: () => {
        throw new Error("site data is blocked");
      },
    });
    expect(readWorkspaceMode()).toBe("ownbot");
    expect(() => writeWorkspaceMode("cowork")).not.toThrow();
  });
});

describe("placing a conversation that does not exist yet", () => {
  test("the half a new conversation will land in follows its recipient", () => {
    expect(modeForCoworker("acp")).toBe("cowork");
    expect(modeForCoworker("api")).toBe("ownbot");
    expect(modeForCoworker("private_local")).toBe("ownbot");
    expect(modeForCoworker("remote")).toBe("ownbot");
    expect(modeForCoworker("unavailable")).toBe("ownbot");
  });

  test("a recipient whose runtime has not loaded does not move anybody", () => {
    // Same stance as an existing channel with an unknown coworker: Ownbot until the roster says
    // otherwise, rather than a mode that flips when the agents query lands.
    expect(modeForCoworker(undefined)).toBe("ownbot");
  });
});
