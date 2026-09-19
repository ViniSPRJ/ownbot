import { createContext, type ReactNode, useContext, useState } from "react";
import {
  type WorkspaceMode,
  readCodingCoworkers,
  readWorkspaceMode,
  toggleCodingCoworker,
  writeCodingCoworkers,
  writeWorkspaceMode,
} from "@/lib/workspace/mode";

type WorkspaceModeContextValue = {
  mode: WorkspaceMode;
  setMode: (mode: WorkspaceMode) => void;
  /** The coworkers this person treats as coding agents. Empty means OwnBot holds everything. */
  coding: ReadonlySet<string>;
  toggleCoding: (agentId: string) => void;
};

const WorkspaceModeContext = createContext<WorkspaceModeContextValue | null>(
  null,
);

/**
 * Which half of the roster is open, and which coworkers put a conversation in the other one.
 *
 * Both are shared because both have more than one mover. The switch changes the mode, and so does
 * starting a conversation — it follows the recipient into whichever half it lands in. The marks are
 * edited from Cowork's empty state and read by the sidebar on every render.
 *
 * Written on change rather than in an effect: these are preferences, not derived values, and an effect
 * would also write them on the first render that merely read them back.
 */
export function WorkspaceModeProvider({ children }: { children: ReactNode }) {
  const [mode, setStored] = useState<WorkspaceMode>(readWorkspaceMode);
  const [coding, setCoding] = useState<ReadonlySet<string>>(readCodingCoworkers);
  const setMode = (next: WorkspaceMode) => {
    setStored(next);
    writeWorkspaceMode(next);
  };
  const toggleCoding = (agentId: string) => {
    const next = toggleCodingCoworker(coding, agentId);
    setCoding(next);
    writeCodingCoworkers(next);
  };

  return (
    <WorkspaceModeContext.Provider
      value={{ mode, setMode, coding, toggleCoding }}
    >
      {children}
    </WorkspaceModeContext.Provider>
  );
}

export function useWorkspaceMode() {
  const value = useContext(WorkspaceModeContext);

  if (!value) {
    throw new Error(
      "useWorkspaceMode must be used within WorkspaceModeProvider",
    );
  }

  return value;
}
