// What the documentation page's and the guide's tests load a design system with: stream T's engine.
import type { DesignSystem } from "../src/server/design/system-types.ts";
import { loadDesignSystem, systemSummary } from "../src/server/design/tokens.ts";

/** Loads `<cwd>/.pi/design/`, or `undefined` when it is absent. */
export const loadSystem = (cwd: string): DesignSystem | undefined => loadDesignSystem(cwd);

/** The prompt text of a system. */
export const summarize = (system: DesignSystem, maxBytes: number): string =>
    systemSummary(system, maxBytes);
