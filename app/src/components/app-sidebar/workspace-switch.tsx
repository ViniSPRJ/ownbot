import { IconMessages, IconTerminal2 } from "@tabler/icons-react";
import type { WorkspaceMode } from "@/lib/workspace/mode";
import { Button } from "../ui/button";

const modes = [
  {
    value: "ownbot" as const,
    label: "Ownbot",
    icon: IconMessages,
    description: "Conversas com os coworkers que respondem por API",
  },
  {
    value: "cowork" as const,
    label: "Cowork",
    icon: IconTerminal2,
    description: "Cockpit dos coding agents, com sessão e modelo por conversa",
  },
];

/**
 * The two halves of the roster, and which one is open.
 *
 * Two real buttons rather than a toggle: both destinations are named, and a single control that says
 * "Cowork" while meaning "you are in Ownbot, press to leave" is the kind of switch people read
 * backwards. `aria-pressed` carries the state, so the current half is announced rather than only
 * shaded.
 *
 * Renders nothing when the deployment has no coworker on an ACP connection — see
 * `workspaceSwitchView`. The caller decides that; this draws what it is told.
 */
export function WorkspaceSwitch({
  mode,
  counts,
  onChange,
}: {
  mode: WorkspaceMode;
  counts: { ownbot: number; cowork: number };
  onChange: (mode: WorkspaceMode) => void;
}) {
  return (
    <fieldset className="flex flex-row gap-px rounded-lg bg-muted/50 p-px m-0 border-0">
      <legend className="sr-only">Workspace</legend>
      {modes.map((option) => {
        const current = option.value === mode;
        const Icon = option.icon;
        return (
          <Button
            aria-pressed={current}
            className="flex-1 justify-start gap-1.5"
            key={option.value}
            onClick={() => onChange(option.value)}
            size="sm"
            title={option.description}
            variant={current ? "secondary" : "ghost"}
          >
            <Icon />
            <span className="tracking-tight">{option.label}</span>
            {/*
             * The count is for the half you are NOT in. Reading "Cowork 3" from Ownbot is what tells
             * somebody there is anything over there at all; repeating the number of rows already on
             * screen underneath them is decoration.
             */}
            {!current && counts[option.value] > 0 ? (
              <span className="ml-auto text-xs text-muted-foreground">
                {counts[option.value]}
              </span>
            ) : null}
          </Button>
        );
      })}
    </fieldset>
  );
}
