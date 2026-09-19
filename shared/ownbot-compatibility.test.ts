import { describe, expect, test } from "bun:test";
import { hasManagedAgentToken } from "./agent-authorisation";
import { ownbotEnv } from "./ownbot-env";
import { ownbotHeader, ownbotRunAssertion } from "./ownbot-protocol";

describe("OwnBot configuration compatibility", () => {
  test("current values override legacy values without reviving an empty or disabled flag", () => {
    for (const current of ["false", "", "current"]) {
      expect(
        ownbotEnv(
          { OWNBOT_SINGLE_USER: current, OPENBOT_SINGLE_USER: "true" },
          "OWNBOT_SINGLE_USER",
        ),
      ).toBe(current);
    }
    expect(
      ownbotEnv({ OPENBOT_SINGLE_USER: "true" }, "OWNBOT_SINGLE_USER"),
    ).toBe("true");
    expect(ownbotEnv({}, "OWNBOT_SINGLE_USER")).toBeUndefined();
  });

  test("reads the current environment each time without mutating it", () => {
    const env = { OPENBOT_ACP_CONFIG: "/old/config" };
    expect(ownbotEnv(env, "OWNBOT_ACP_CONFIG")).toBe("/old/config");
    env.OPENBOT_ACP_CONFIG = "/old/updated";
    expect(ownbotEnv(env, "OWNBOT_ACP_CONFIG")).toBe("/old/updated");
    expect(Object.keys(env)).toEqual(["OPENBOT_ACP_CONFIG"]);
  });
});

describe("OwnBot peer compatibility", () => {
  test("managed agents accept either token name and reject disagreeing aliases", () => {
    for (const headers of [
      { "x-ownbot-agent-token": "expected" },
      { "x-openbot-agent-token": "expected" },
      {
        "x-ownbot-agent-token": "expected",
        "x-openbot-agent-token": "expected",
      },
    ]) {
      expect(
        hasManagedAgentToken(
          new Request("http://ownbot.test", { headers }),
          "expected",
        ),
      ).toBe(true);
    }
    for (const current of ["wrong", ""]) {
      expect(
        hasManagedAgentToken(
          new Request("http://ownbot.test", {
            headers: {
              "x-ownbot-agent-token": current,
              "x-openbot-agent-token": "expected",
            },
          }),
          "expected",
        ),
      ).toBe(false);
    }
  });

  test("computer identity cannot differ between aliases", () => {
    expect(
      ownbotHeader(
        new Headers({
          "x-ownbot-bot-id": "research",
          "x-openbot-bot-id": "credit",
        }),
        "bot-id",
      ),
    ).toBeNull();
    expect(
      ownbotHeader(new Headers({ "x-openbot-bot-id": "credit" }), "bot-id"),
    ).toBe("credit");
  });

  test("signed assertion aliases cannot disagree", () => {
    expect(ownbotRunAssertion({ ownbotRun: "signed" })).toBe("signed");
    expect(ownbotRunAssertion({ openbotRun: "signed" })).toBe("signed");
    expect(
      ownbotRunAssertion({ ownbotRun: "signed", openbotRun: "signed" }),
    ).toBe("signed");
    expect(
      ownbotRunAssertion({ ownbotRun: "other", openbotRun: "signed" }),
    ).toBeUndefined();
    expect(
      ownbotRunAssertion({ ownbotRun: null, openbotRun: "signed" }),
    ).toBeUndefined();
  });
});
