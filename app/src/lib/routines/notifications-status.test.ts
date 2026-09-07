import { expect, test } from "bun:test";
import { runNotificationStatus, type Execution } from "./executions";
test("internal inbox availability never reports legacy Telegram backlog as pending", () => {
  const run = {
    notificationDelivery: "internal",
    internalNotificationAvailable: true,
    notificationStatus: "pending",
    finishedAt: "2026-09-06",
  } as Execution;
  expect(runNotificationStatus(run)).toBe("Notificação interna disponível");
  expect(
    runNotificationStatus({ ...run, internalNotificationAvailable: false }),
  ).toBe("Notificação interna pendente");
  expect(
    runNotificationStatus({
      ...run,
      internalNotificationAvailable: false,
      finishedAt: null,
    }),
  ).toBe("Notificação após a conclusão");
});
test("other deployments keep explicitly labelled Telegram delivery", () => {
  expect(
    runNotificationStatus({
      notificationDelivery: "telegram",
      notificationStatus: "sent",
    } as Execution),
  ).toBe("Telegram: Entrega confirmada pelo notificador");
});
