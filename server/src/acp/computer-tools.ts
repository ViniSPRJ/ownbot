import { randomUUID } from "node:crypto";
import { parametersFor, type GrantedTool } from "../plugins/tools";
import type { HeadlessComputer } from "../routines/headless-computer";

/** Execute ACP computer calls through the existing policy/audit gateway, never native CLI shell. */
export function acpComputerTools(
  computer: HeadlessComputer,
  botId: string,
  ownerUserId: string,
): GrantedTool[] {
  return computer.tools.map(tool => ({
    name: tool.name,
    ref: `computer/${tool.name}`,
    description: tool.description,
    parameters: parametersFor(tool.parameters as Record<string, unknown>),
    execute: async args => JSON.stringify(await computer.call({
      botId, ownerUserId, name: tool.name, args, toolCallId: randomUUID(),
    })),
  }));
}
