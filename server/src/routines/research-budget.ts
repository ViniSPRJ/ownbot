import type { GrantedTool } from "../plugins/tools";
import { createNewsEvidence } from "./news-evidence";

/** Explicit opt-in in a saved routine; never applied to ordinary chat or other routines. */
export const RESEARCH_BUDGET_MARKER = "[OWNBOT_RESEARCH_BUDGET_V1]";
const BROWSER_READS = new Set([
  "computer_navigate", "computer_read", "computer_snapshot", "computer_click",
  "computer_scroll", "computer_key", "computer_type",
]);

export type RoutineResearchBudget = ReturnType<typeof createRoutineResearchBudget>;

export function createRoutineResearchBudget(
  timeoutMs: number,
  now: () => number = () => performance.now(),
) {
  const started = now();
  const editorial = createNewsEvidence();
  const reserveMs = Math.min(90_000, timeoutMs / 4);
  const researchMs = Math.max(0, timeoutMs - reserveMs);
  const maxCalls = 14;
  let calls = 0;
  const staleRefs = new Set<string>();
  let serial: Promise<unknown> = Promise.resolve();
  const remaining = () => Math.max(0, Math.floor((timeoutMs - (now() - started)) / 1000));
  const guidance = () =>
    `Ownbot routine budget: ${remaining()} seconds remain; ${Math.max(0, maxCalls - calls)} browser calls remain. ` +
    `Reserve the final ${Math.round(reserveMs / 1000)} seconds for the complete requested report. ` +
    "Cover every requested section, cite only retrieved evidence, and label source limitations. Never substitute fabricated facts for missing evidence. Before the final answer register every cited article with news_record_evidence (actual body, author, literal excerpt). Read actual FT and Valor opinion articles, not homepage links. Unverified publication dates are context only, not current news.";

  return {
    guidance,
    finalise: editorial.finalise,
    wrap(tools: GrantedTool[]): GrantedTool[] {
      const wrapped = tools.map(tool => {
        if (!BROWSER_READS.has(tool.name)) return tool;
        return {
          ...tool,
          execute: (args: unknown) => {
            const execute = async () => {
              if (calls >= maxCalls || now() - started >= researchMs)
                return "Refused. The routine's research budget has ended. Write the full requested report now using collected evidence and explicit source limitations.\n" + guidance();
              const values = args && typeof args === "object" ? args as Record<string, unknown> : {};
              const ref = typeof values.ref === "string" ? values.ref : null;
              if (ref && staleRefs.has(ref) && tool.name !== "computer_snapshot")
                return "Refused. This browser ref already failed as stale. Do not repeat it; take one fresh snapshot or move to the remaining sources.\n" + guidance();
              calls += 1;
              const answer = await tool.execute(args);
              editorial.capture(tool.name, answer);
              if (ref && /"staleRefs"\s*:\s*true|not on the page any more|refs are stale/i.test(answer))
                staleRefs.add(ref);
              if (tool.name === "computer_snapshot") {
                try {
                  if (JSON.parse(answer)?.ok === true) staleRefs.clear();
                } catch { /* An unreadable/failed snapshot cannot refresh stale references. */ }
              }
              return answer + "\n\n" + guidance();
            };
            // One browser belongs to this run; concurrent navigation invalidates the other call's refs.
            const pending = serial.then(execute, execute);
            serial = pending.catch(() => {});
            return pending;
          },
        };
      });
      return [...wrapped, editorial.tool];
    },
  };
}
