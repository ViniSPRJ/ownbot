import { createContext, type ReactNode, useContext, useState } from "react";
import {
  type WorkspaceMode,
  readWorkspaceMode,
  writeWorkspaceMode,
} from "@/lib/workspace/mode";

type WorkspaceModeContextValue = {
  mode: WorkspaceMode;
  setMode: (mode: WorkspaceMode) => void;
};

const WorkspaceModeContext = createContext<WorkspaceModeContextValue | null>(
  null,
);

/**
 * Which half of the roster is open, shared by everything that can move it.
 *
 * It started as state inside the sidebar, which was enough while the switch was the only thing that
 * changed it. It is not: starting a conversation with a coding coworker from Ownbot used to file it in
 * the other half and leave the person looking at the roster it is not in. Nothing about the mode is
 * per-route, so it is held above the routes rather than threaded through them.
 */
export function WorkspaceModeProvider({ children }: { children: ReactNode }) {
  const [mode, setStored] = useState<WorkspaceMode>(readWorkspaceMode);
  const setMode = (next: WorkspaceMode) => {
    setStored(next);
    // Written on every change rather than in an effect: this is a preference, not a derived value, and
    // an effect would also write it on the first render that merely read it back.
    writeWorkspaceMode(next);
  };

  return (
    <WorkspaceModeContext.Provider value={{ mode, setMode }}>
      {children}
    </WorkspaceModeContext.Provider>
  );
}

export function useWorkspaceMode() {
  const value = useContext(WorkspaceModeContext);

  if (!value) {
    throw new Error("useWorkspaceMode must be used within WorkspaceModeProvider");
  }

  return value;
}
