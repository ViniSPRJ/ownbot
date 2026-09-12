import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { WorkspaceSwitch } from "@/components/app-sidebar/workspace-switch";
import {
  WorkspaceModeProvider,
  useWorkspaceMode,
} from "@/components/workspace-mode-provider";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

/**
 * The switch, actually rendered.
 *
 * Placement is covered as pure functions in workspace-mode.test.ts. What only a render can say is that
 * the open half is announced rather than merely shaded, that clicking the other one reports the mode it
 * names, and that the count belongs to the half nobody can see.
 *
 * Queries go through the rendered container rather than `screen`, as in button-native.test.ts: `screen`
 * binds to `document.body` when it is imported, which is before `GlobalRegistrator` has made one.
 */
function drawing(element: ReactElement) {
  const { container } = render(element);
  const buttons = [...container.querySelectorAll("button")];
  return {
    container,
    button: (label: string) =>
      buttons.find((candidate) => candidate.textContent?.includes(label))!,
  };
}

test("the open half is announced, not only shaded", () => {
  const { button } = drawing(
    <WorkspaceSwitch
      counts={{ ownbot: 4, cowork: 2 }}
      mode="ownbot"
      onChange={() => {}}
    />,
  );
  expect(button("Ownbot").getAttribute("aria-pressed")).toBe("true");
  expect(button("Cowork").getAttribute("aria-pressed")).toBe("false");
});

test("the count shown is the other half's, because that is the one you cannot see", () => {
  const { button } = drawing(
    <WorkspaceSwitch
      counts={{ ownbot: 4, cowork: 2 }}
      mode="ownbot"
      onChange={() => {}}
    />,
  );
  // 2 conversations are over in Cowork. The 4 in Ownbot are already on screen underneath this.
  expect(button("Cowork").textContent).toContain("2");
  expect(button("Ownbot").textContent).not.toContain("4");
});

test("clicking the other half reports the mode it names", () => {
  const chosen: string[] = [];
  const { button } = drawing(
    <WorkspaceSwitch
      counts={{ ownbot: 1, cowork: 1 }}
      mode="ownbot"
      onChange={(next) => chosen.push(next)}
    />,
  );
  button("Cowork").click();
  expect(chosen).toEqual(["cowork"]);
});

function Probe() {
  const { mode, setMode } = useWorkspaceMode();
  return (
    <button onClick={() => setMode("cowork")} type="button">
      {mode}
    </button>
  );
}

test("the shared mode is remembered where the next visit will read it", () => {
  // The provider is what lets the route that starts a conversation move the sidebar. Both halves of
  // that are asserted here: the value a consumer reads, and the preference the next load starts from.
  const written: Record<string, string> = {};
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => written[key] ?? null,
      setItem: (key: string, value: string) => {
        written[key] = value;
      },
    },
  });
  try {
    const { container } = render(
      <WorkspaceModeProvider>
        <Probe />
      </WorkspaceModeProvider>,
    );
    const probe = container.querySelector("button")!;
    expect(probe.textContent).toBe("ownbot");
    // Through `fireEvent`, which wraps the dispatch in `act`: a bare `.click()` leaves the state update
    // unflushed and the assertion below reads the render before it.
    fireEvent.click(probe);
    expect(container.querySelector("button")?.textContent).toBe("cowork");
    expect(written["openbot.workspace-mode"]).toBe("cowork");
  } finally {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: original,
    });
  }
});
