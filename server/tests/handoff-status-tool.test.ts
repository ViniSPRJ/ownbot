import { describe, expect, test } from "bun:test";
import {
  type HandoffStatus,
  handoffStatusTool,
  mapHandoffReturnStatus,
  mapHandoffWorkStatus,
} from "../src/agents/handoff-status-tool";

const FROM = {
  botId: "coord",
  actorId: "user-1",
  runId: "run-1",
  threadId: "thread-1",
};

describe("handoff status mapping", () => {
  test("unknown outcome stays unknown after the row is finished", () => {
    expect(
      mapHandoffWorkStatus({
        outcome: "unknown",
        finished: true,
        running: false,
        attempts: 1,
      }),
    ).toBe("unknown");
  });

  test("reconciled outcome is reconciled, not completed", () => {
    expect(
      mapHandoffWorkStatus({
        outcome: "reconciled",
        finished: true,
        running: false,
        attempts: 1,
      }),
    ).toBe("reconciled");
  });

  test("a finished hop without those outcomes is still completed", () => {
    expect(
      mapHandoffWorkStatus({
        outcome: undefined,
        finished: true,
        running: false,
        attempts: 1,
      }),
    ).toBe("completed");
    expect(
      mapHandoffWorkStatus({
        outcome: "ok",
        finished: true,
        running: false,
        attempts: 1,
      }),
    ).toBe("completed");
  });

  test("lifecycle states are unchanged when there is no result outcome", () => {
    expect(
      mapHandoffWorkStatus({
        outcome: null,
        finished: false,
        running: true,
        attempts: 1,
      }),
    ).toBe("running");
    expect(
      mapHandoffWorkStatus({
        outcome: null,
        finished: false,
        running: false,
        attempts: 5,
      }),
    ).toBe("failed");
    expect(
      mapHandoffWorkStatus({
        outcome: null,
        finished: false,
        running: false,
        attempts: 2,
      }),
    ).toBe("retry_pending");
    expect(
      mapHandoffWorkStatus({
        outcome: null,
        finished: false,
        running: false,
        attempts: 0,
      }),
    ).toBe("queued");
  });

  test("a finished relay with unknown outcome is unknown, never processed", () => {
    expect(
      mapHandoffReturnStatus({
        present: true,
        outcome: "unknown",
        finished: true,
        running: false,
        attempts: 1,
      }),
    ).toBe("unknown");
  });

  test("a finished relay with reconciled outcome is reconciled, never processed", () => {
    expect(
      mapHandoffReturnStatus({
        present: true,
        outcome: "reconciled",
        finished: true,
        running: false,
        attempts: 1,
      }),
    ).toBe("reconciled");
  });

  test("a finished relay without those outcomes is processed", () => {
    expect(
      mapHandoffReturnStatus({
        present: true,
        outcome: null,
        finished: true,
        running: false,
        attempts: 1,
      }),
    ).toBe("processed");
  });

  test("a missing relay stays null", () => {
    expect(
      mapHandoffReturnStatus({
        present: false,
        outcome: "unknown",
        finished: true,
        running: false,
        attempts: 1,
      }),
    ).toBeNull();
  });
});

describe("handoff_status tool", () => {
  test("returns the durable status JSON for a job in this conversation", async () => {
    const status: HandoffStatus = {
      jobId: "hop:1",
      status: "unknown",
      answer: null,
      returnStatus: null,
    };
    const tool = handoffStatusTool(async () => status, FROM);
    expect(JSON.parse(await tool.execute({ jobId: "hop:1" }))).toEqual(status);
  });

  test("omits reconciliation metadata when the reader did not supply it", async () => {
    const tool = handoffStatusTool(
      async () => ({
        jobId: "hop:1",
        status: "completed",
        answer: "Saved answer",
        returnStatus: "queued",
      }),
      FROM,
    );
    expect(JSON.parse(await tool.execute({ jobId: "hop:1" }))).toEqual({
      jobId: "hop:1",
      status: "completed",
      answer: "Saved answer",
      returnStatus: "queued",
    });
  });

  test("includes resolution only when the reader supplied it", async () => {
    const tool = handoffStatusTool(
      async () => ({
        jobId: "hop:1",
        status: "reconciled",
        answer: null,
        returnStatus: null,
        resolution: "internal_record_archived",
      }),
      FROM,
    );
    expect(JSON.parse(await tool.execute({ jobId: "hop:1" }))).toEqual({
      jobId: "hop:1",
      status: "reconciled",
      answer: null,
      returnStatus: null,
      resolution: "internal_record_archived",
    });
  });

  test("a missing job is answered rather than thrown", async () => {
    const tool = handoffStatusTool(async () => null, FROM);
    await expect(tool.execute({ jobId: "missing" })).resolves.toContain(
      "Job not found",
    );
  });

  test("a call missing the job id is answered rather than thrown", async () => {
    const tool = handoffStatusTool(async () => null, FROM);
    await expect(tool.execute({})).resolves.toContain("exact Job ID");
  });
});
