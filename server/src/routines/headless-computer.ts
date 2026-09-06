/**
 * The computer tools for a headless turn.
 *
 * In the browser, `app/src/lib/copilot/computer-tools.tsx` registers the computer tools as frontend
 * tools: the model calls one, the run ends, the browser executes it against `/api/computers/:botId`
 * and runs the agent again with the result. A routine firing has no browser, so until this file
 * existed a routine's Bot had no computer at all: it could not open a page, read a file or run a
 * script, and every instruction that asked for one ended with the Bot explaining that it lacked the
 * tool. This is the server-side stand-in for those handlers: the same tool names and parameters the
 * browser offers, executed straight through the gateway, so policy and audit apply exactly as they
 * do for a person's turn.
 *
 * What is deliberately NOT offered: `computer_request_help` and `computer_request_secret`, which
 * wait for a person, and `report_refusal`, which is a display concern. A call to any of those, or to
 * a name this file does not know, is answered with a refusal that says nobody is present, so the
 * model can say so instead of the turn hanging.
 */
import type { Tool } from "@ag-ui/client";
import {
  ElementNotFoundError,
  HumanHasControlError,
  NavigationRefusedError,
  StaleSnapshotError,
  WorkspaceRefusedError,
} from "../computer/client";
import {
  type ActionActor,
  ActionRefusedError,
  type ComputerGateway,
} from "../computer/gateway";

/** What every computer call returns to the model: either the result, or a reason it did not happen. */
export type ToolOutcome = Record<string, unknown> & { ok: boolean };

export type HeadlessComputer = {
  /** The tools to offer the model, in AG-UI's shape. */
  readonly tools: Tool[];
  call(input: {
    botId: string;
    ownerUserId: string;
    name: string;
    args: unknown;
    toolCallId: string;
    signal?: AbortSignal;
  }): Promise<ToolOutcome>;
};

const NO_PERSON =
  "Nobody is present during a scheduled routine, so this cannot be asked for. Say what you could not do and carry on with what you can.";

/**
 * The same descriptions as the browser's registrations, minus the sentences about the person watching.
 * Parameters are JSON Schema, which is what the zod objects in the browser compile to on the wire.
 */
export const HEADLESS_COMPUTER_TOOLS: Tool[] = [
  {
    name: "computer_navigate",
    description:
      "Open a web page on your own computer. Use this when asked to look at, visit, open or check a " +
      "website. Returns the page title and its readable text, so answer from what comes back.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Full web address to open, including https://",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "computer_read",
    description:
      "Read the page currently open on your computer, without opening anything. Use this after you " +
      "click something that changes the page, such as submitting a form, to find out what it now says.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "computer_snapshot",
    description:
      "List the things on the current page you can act on: fields, buttons, links and checkboxes, " +
      "each with a ref, its label and its current value. Call this BEFORE clicking or typing, and " +
      "use the refs it returns. Always send back the snapshotId it gives you. If an action reports " +
      "that your refs are stale, the page changed: call this again and use the new refs.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "computer_type",
    description:
      "Enter text into a field on the page. Give the ref of the field from your most recent " +
      "snapshot and the snapshotId it came from. This replaces whatever the field already contains. " +
      "Set submit to true to press Enter afterwards.",
    parameters: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description: "Ref of the field, from your most recent snapshot",
        },
        snapshotId: {
          type: "number",
          description: "The snapshotId that ref came from",
        },
        text: { type: "string", description: "The text to enter" },
        submit: {
          type: "boolean",
          description: "Press Enter after typing, to submit a single-field form",
        },
      },
      required: ["ref", "snapshotId", "text"],
    },
  },
  {
    name: "computer_click",
    description:
      "Click something on the page: a button, a link, a checkbox or a radio option. Give the ref " +
      "from your most recent snapshot and the snapshotId it came from.",
    parameters: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description: "Ref of the element to click, from your most recent snapshot",
        },
        snapshotId: {
          type: "number",
          description: "The snapshotId that ref came from",
        },
      },
      required: ["ref", "snapshotId"],
    },
  },
  {
    name: "computer_key",
    description:
      "Press a key, such as Enter, Tab or Escape. Give a ref to press it while a particular field " +
      "is focused, or omit the ref to press it on the page.",
    parameters: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Key name, such as Enter, Tab or Escape",
        },
        ref: { type: "string", description: "Optional ref to press the key on" },
        snapshotId: {
          type: "number",
          description: "The snapshotId the ref came from, required if ref is given",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "computer_scroll",
    description:
      "Scroll the page down, or up with a negative amount, to bring more of a long page into view.",
    parameters: {
      type: "object",
      properties: {
        deltaY: {
          type: "number",
          description: "Pixels to scroll; positive is down. Defaults to 600.",
        },
      },
    },
  },
  {
    name: "computer_list_files",
    description:
      "List what is in your workspace: every file and folder you have saved, with sizes. Call this " +
      "FIRST when you are asked what files you have, or before reading a file whose exact name you " +
      "are not sure of. Never guess a filename.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Optional folder to list. Omit for the whole workspace.",
        },
      },
    },
  },
  {
    name: "computer_read_file",
    description:
      "Read a file you saved earlier in your own workspace. Paths are relative to your workspace, " +
      "such as notes.md or reports/august.csv. Your workspace survives between conversations, so use " +
      "this to pick up notes you made before.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path relative to your workspace, such as notes.md",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "computer_run_command",
    description:
      "Run a shell command on your own computer. Use this for anything the browser cannot do: " +
      "processing a file you saved, running a script. The working directory is your workspace, so " +
      "paths are relative to it and files you write here are the same ones the file tools see. " +
      "Commands run in bash, so pipes and && work. Long output is truncated from the start, and a " +
      "command that runs too long is stopped.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The command to run, such as: python3 /opt/scripts/report.py",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "computer_write_file",
    description:
      "Save a file in your own workspace so you still have it later. Paths are relative to your " +
      "workspace and folders are created as needed. Set append to true to add to the end of an " +
      "existing file rather than replacing it. Text only.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path relative to your workspace, such as reports/august.csv",
        },
        contents: { type: "string", description: "The text to save" },
        append: {
          type: "boolean",
          description: "Add to the end of the file instead of replacing it",
        },
      },
      required: ["path", "contents"],
    },
  },
];

type Args = Record<string, unknown>;

function asArgs(value: unknown): Args {
  return value !== null && typeof value === "object" ? (value as Args) : {};
}

function asRef(args: Args): { ref: string; snapshotId: number } | undefined {
  if (typeof args.ref !== "string" || !args.ref) return undefined;
  if (typeof args.snapshotId !== "number") return undefined;
  return { ref: args.ref, snapshotId: args.snapshotId };
}

const BAD_REF: ToolOutcome = {
  ok: false,
  reason:
    "A ref and the snapshotId it came from are required. Call computer_snapshot first and use what it returns.",
  staleRefs: true,
};

/**
 * The same distinctions `callComputer` draws from a status and a body in the browser, drawn here from
 * the error classes the gateway throws, because those decide the model's next step: a refusal is not
 * retried, stale refs mean "snapshot again", a person holding the wheel means wait.
 */
function outcomeOf(error: unknown): ToolOutcome {
  const reason = error instanceof Error ? error.message : "That did not work.";
  if (error instanceof ActionRefusedError) {
    return { ok: false, reason, refused: true, rule: error.rule };
  }
  if (
    error instanceof NavigationRefusedError ||
    error instanceof WorkspaceRefusedError
  ) {
    return { ok: false, reason, refused: true, rule: null };
  }
  if (
    error instanceof StaleSnapshotError ||
    error instanceof ElementNotFoundError
  ) {
    return { ok: false, reason, staleRefs: true };
  }
  if (error instanceof HumanHasControlError) {
    return { ok: false, reason, humanHasControl: true };
  }
  return { ok: false, reason };
}

export function createHeadlessComputer(options: {
  gateway: ComputerGateway;
  /** The routine's owner as the gateway's actor, for policy and the audit trail. */
  actorFor: (ownerUserId: string) => ActionActor;
}): HeadlessComputer {
  const { gateway, actorFor } = options;

  async function perform(
    botId: string,
    actor: ActionActor,
    name: string,
    args: Args,
    signal: AbortSignal | undefined,
  ): Promise<ToolOutcome> {
    switch (name) {
      case "computer_navigate": {
        if (typeof args.url !== "string" || !args.url.trim()) {
          return { ok: false, reason: "A web address is required." };
        }
        const result = await gateway.navigate(botId, actor, args.url.trim());
        return { ok: true, ...result };
      }
      case "computer_read":
        return { ok: true, ...(await gateway.read(botId)) };
      case "computer_snapshot":
        return { ok: true, ...(await gateway.snapshot(botId)) };
      case "computer_click": {
        const ref = asRef(args);
        if (!ref) return BAD_REF;
        return { ok: true, ...(await gateway.click(botId, actor, ref, signal)) };
      }
      case "computer_type": {
        const ref = asRef(args);
        if (!ref) return BAD_REF;
        if (typeof args.text !== "string") {
          return { ok: false, reason: "The text to enter is required." };
        }
        return {
          ok: true,
          ...(await gateway.type(
            botId,
            actor,
            { ...ref, text: args.text, submit: args.submit === true },
            signal,
          )),
        };
      }
      case "computer_key": {
        if (typeof args.key !== "string" || !args.key) {
          return {
            ok: false,
            reason: "A key name is required, such as Enter or Tab.",
          };
        }
        return {
          ok: true,
          ...(await gateway.key(
            botId,
            actor,
            { key: args.key, ...(asRef(args) ?? {}) },
            signal,
          )),
        };
      }
      case "computer_scroll":
        return {
          ok: true,
          ...(await gateway.scroll(botId, actor, {
            ...(typeof args.deltaY === "number" ? { deltaY: args.deltaY } : {}),
          })),
        };
      case "computer_list_files":
        return {
          ok: true,
          ...(await gateway.listFiles(botId, actor, {
            ...(typeof args.path === "string" && args.path.trim()
              ? { path: args.path.trim() }
              : {}),
          })),
        };
      case "computer_read_file": {
        if (typeof args.path !== "string" || !args.path.trim()) {
          return { ok: false, reason: "A file path is required." };
        }
        return {
          ok: true,
          ...(await gateway.readFile(botId, actor, { path: args.path.trim() })),
        };
      }
      case "computer_run_command": {
        if (typeof args.command !== "string" || !args.command.trim()) {
          return { ok: false, reason: "A command is required." };
        }
        return {
          ok: true,
          ...(await gateway.runCommand(
            botId,
            actor,
            { command: args.command },
            signal,
          )),
        };
      }
      case "computer_write_file": {
        if (typeof args.path !== "string" || !args.path.trim()) {
          return { ok: false, reason: "A file path is required." };
        }
        if (typeof args.contents !== "string") {
          return { ok: false, reason: "The text to save is required." };
        }
        return {
          ok: true,
          ...(await gateway.writeFile(botId, actor, {
            path: args.path.trim(),
            contents: args.contents,
            ...(args.append === true ? { append: true } : {}),
          })),
        };
      }
      default:
        return { ok: false, reason: NO_PERSON, refused: true, rule: null };
    }
  }

  return {
    tools: HEADLESS_COMPUTER_TOOLS,
    async call({ botId, ownerUserId, name, args, signal }) {
      try {
        return await perform(botId, actorFor(ownerUserId), name, asArgs(args), signal);
      } catch (error) {
        return outcomeOf(error);
      }
    },
  };
}
