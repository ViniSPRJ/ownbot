import { afterEach, describe, expect, test } from "bun:test";
import {
  channelsForMode,
  isCoworkChannel,
  modeForCoworker,
  readCodingCoworkers,
  readWorkspaceMode,
  toggleCodingCoworker,
  workspaceSwitchView,
  writeCodingCoworkers,
  writeWorkspaceMode,
} from "@/lib/workspace/mode";

const channel = (...agentIds: string[]) => ({ agentIds });
const coding = (...ids: string[]) => new Set(ids);

describe("placing a conversation in one half of the roster", () => {
  test("a marked coworker puts its conversation in the cockpit", () => {
    expect(isCoworkChannel(channel("codeexec"), coding("codeexec"))).toBe(true);
    expect(isCoworkChannel(channel("coord"), coding("codeexec"))).toBe(false);
  });

  test("NOTHING IS IN THE COCKPIT UNTIL SOMEBODY PUTS IT THERE", () => {
    /*
     * The regression this file exists for. Placement used to be derived from the runtime: ACP meant a
     * CLI, a CLI meant a coding agent. On the deployment this shipped to, the operator maps all ten
     * coworkers to Codex, Claude and Grok, so every channel matched, Cowork took the entire roster and
     * OwnBot went empty. With no marks, every conversation is in OwnBot no matter how it runs.
     */
    const everything = [
      channel("coord"),
      channel("desk"),
      channel("news"),
      channel("codeexec"),
    ];
    expect(
      everything.filter((c) => isCoworkChannel(c, coding())),
    ).toEqual([]);
    expect(channelsForMode("ownbot", everything, coding())).toBe(everything);
    expect(channelsForMode("cowork", everything, coding())).toEqual([]);
  });

  test("one marked coworker in a mixed channel is enough", () => {
    // The cockpit is where that coworker's session, workspace and model selection can be seen at all.
    expect(isCoworkChannel(channel("coord", "codeexec"), coding("codeexec"))).toBe(
      true,
    );
  });

  test("a channel with no coworkers is nobody's", () => {
    expect(isCoworkChannel(channel(), coding("codeexec"))).toBe(false);
  });
});

describe("what the switch offers", () => {
  const channels = [channel("coord"), channel("codeexec"), channel("coord", "pi")];

  test("the door into an empty cockpit is still a door", () => {
    // `available` asks whether a cockpit is possible, not whether it is populated. Hiding the switch
    // until something is marked would hide the only place to mark anything.
    const view = workspaceSwitchView({
      stored: "cowork",
      channels,
      coding: coding(),
      hasAcpCoworker: true,
    });
    expect(view.available).toBe(true);
    expect(view.mode).toBe("cowork");
    expect(view.counts).toEqual({ ownbot: 3, cowork: 0 });
  });

  test("a deployment with no ACP coworker at all has no cockpit", () => {
    const view = workspaceSwitchView({
      stored: "cowork",
      channels,
      coding: coding("codeexec"),
      hasAcpCoworker: false,
    });
    expect(view.available).toBe(false);
    // And somebody left in Cowork is shown OwnBot rather than a cockpit a reload cannot leave.
    expect(view.mode).toBe("ownbot");
  });

  test("both halves are counted, so each side can say what is on the other", () => {
    const view = workspaceSwitchView({
      stored: "ownbot",
      channels,
      coding: coding("codeexec", "pi"),
      hasAcpCoworker: true,
    });
    expect(view.counts).toEqual({ ownbot: 1, cowork: 2 });
  });

  test("a roster that has not arrived counts nothing", () => {
    const view = workspaceSwitchView({
      stored: "ownbot",
      channels: undefined,
      coding: coding("codeexec"),
      hasAcpCoworker: true,
    });
    expect(view.counts).toEqual({ ownbot: 0, cowork: 0 });
  });
});

describe("narrowing the roster to the mode in force", () => {
  test("each mode shows its own conversations and none of the other's", () => {
    const channels = [channel("coord"), channel("codeexec"), channel("coord", "pi")];
    const marked = coding("codeexec", "pi");
    expect(channelsForMode("ownbot", channels, marked)).toEqual([
      channel("coord"),
    ]);
    expect(channelsForMode("cowork", channels, marked)).toEqual([
      channel("codeexec"),
      channel("coord", "pi"),
    ]);
  });

  test("filtering nothing out returns the same array, not a copy of it", () => {
    // A fresh array identity restages every animated row, and OwnBot holding everything is the default.
    const channels = [channel("codeexec"), channel("pi")];
    expect(channelsForMode("cowork", channels, coding("codeexec", "pi"))).toBe(
      channels,
    );
    expect(channelsForMode("ownbot", undefined, coding())).toEqual([]);
  });
});

describe("placing a conversation that does not exist yet", () => {
  test("a new conversation follows its recipient's mark, not its runtime", () => {
    expect(modeForCoworker("codeexec", coding("codeexec"))).toBe("cowork");
    expect(modeForCoworker("coord", coding("codeexec"))).toBe("ownbot");
    expect(modeForCoworker("codeexec", coding())).toBe("ownbot");
  });
});

describe("remembering the marks and the mode locally", () => {
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

  test("a stored mode comes back, and anything else reads as OwnBot", () => {
    const store = new Map<string, string>([
      ["ownbot.workspace-mode", "cowork"],
    ]);
    stub({ getItem: (key: string) => store.get(key) ?? null });
    expect(readWorkspaceMode()).toBe("cowork");
    store.set("ownbot.workspace-mode", "cockpit");
    expect(readWorkspaceMode()).toBe("ownbot");
  });

  test("legacy coworker grouping and mode survive while new writes take precedence", () => {
    const store = new Map<string, string>([
      ["openbot.workspace-mode", "cowork"],
      ["openbot.cowork-coworkers", '["codeexec"]'],
    ]);
    stub({
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    });
    expect(readWorkspaceMode()).toBe("cowork");
    expect([...readCodingCoworkers()]).toEqual(["codeexec"]);
    writeWorkspaceMode("ownbot");
    writeCodingCoworkers(new Set());
    expect(readWorkspaceMode()).toBe("ownbot");
    expect([...readCodingCoworkers()]).toEqual([]);
    expect(store.get("openbot.cowork-coworkers")).toBe('["codeexec"]');
  });

  test("the marks survive a reload, and junk reads as no marks", () => {
    const store = new Map<string, string>();
    stub({
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    });
    writeCodingCoworkers(coding("codeexec", "pi"));
    expect([...readCodingCoworkers()].sort()).toEqual(["codeexec", "pi"]);
    // Not an array, an array of the wrong thing, and not JSON at all: none of them invent a mark.
    store.set("ownbot.cowork-coworkers", '{"codeexec":true}');
    expect([...readCodingCoworkers()]).toEqual([]);
    store.set("ownbot.cowork-coworkers", "[1,2,null]");
    expect([...readCodingCoworkers()]).toEqual([]);
    store.set("ownbot.cowork-coworkers", "not json");
    expect([...readCodingCoworkers()]).toEqual([]);
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
    expect([...readCodingCoworkers()]).toEqual([]);
    expect(() => writeWorkspaceMode("cowork")).not.toThrow();
    expect(() => writeCodingCoworkers(coding("codeexec"))).not.toThrow();
  });

  test("toggling a mark leaves the set it was given alone", () => {
    const before = coding("codeexec");
    expect([...toggleCodingCoworker(before, "pi")].sort()).toEqual([
      "codeexec",
      "pi",
    ]);
    expect([...toggleCodingCoworker(before, "codeexec")]).toEqual([]);
    expect([...before]).toEqual(["codeexec"]);
  });
});
