import { IconCheck, IconTerminal2 } from "@tabler/icons-react";
import { Button } from "../ui/button";

/**
 * Naming the coding agents, from the empty cockpit itself.
 *
 * Here rather than on each coworker's settings page because this is where the question occurs to
 * somebody: they have opened Cowork, it is empty, and what it needs is the one piece of information
 * nothing else in the deployment holds. The operator's ACP mapping says which coworkers run on a CLI;
 * it cannot say which of them a person thinks of as a coding agent, and on a deployment where every
 * coworker runs on a CLI that distinction is the whole of the split.
 *
 * Only ACP coworkers are offered. A coworker answering through the API has no session, no workspace
 * and no model to choose for one conversation, so a cockpit has nothing to show for it.
 */
export function CoworkCoworkers({
  coworkers,
  coding,
  onToggle,
}: {
  coworkers: readonly { id: string; name: string }[];
  coding: ReadonlySet<string>;
  onToggle: (agentId: string) => void;
}) {
  if (coworkers.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 pt-3">
      <p className="px-1 text-xs text-muted-foreground text-pretty">
        Quais coworkers são seus coding agents? As conversas deles aparecem aqui.
      </p>
      {coworkers.map((coworker) => {
        const marked = coding.has(coworker.id);
        return (
          <Button
            aria-pressed={marked}
            className="h-8 justify-start gap-1.5"
            key={coworker.id}
            onClick={() => onToggle(coworker.id)}
            size="sm"
            variant={marked ? "secondary" : "ghost"}
          >
            {marked ? <IconCheck /> : <IconTerminal2 className="opacity-40" />}
            <span className="truncate">{coworker.name}</span>
          </Button>
        );
      })}
    </div>
  );
}
