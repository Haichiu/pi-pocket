// What the documentation page's and the guide's tests load a design system with: stream T's real loader when its
// `tokens.ts` exists, else the stand-in `tokens-stub.ts`. Either way the tests ask for the same two functions.
import type { DesignSystem } from "../src/server/design/system-types.ts";
import {
    loadDesignSystem as loadStub,
    systemSummary as summaryStub,
} from "../src/server/design/tokens-stub.ts";

type Engine = {
    loadDesignSystem?: (cwd: string) => DesignSystem | undefined;
    systemSummary?: (system: DesignSystem, maxBytes: number) => string;
};

// A variable, so that the type check does not need the file before stream T has written it.
const REAL = "../src/server/design/tokens.ts";

const real = (await import(REAL).catch((error: NodeJS.ErrnoException) => {
    // Only "the file is not there yet" falls back; a loader that fails to load is a failure to see.
    if (error.code === "ERR_MODULE_NOT_FOUND" && String(error.message).includes("tokens.ts")) {
        return undefined;
    }

    throw error;
})) as Engine | undefined;

/** Loads `<cwd>/.pi/design/`, or `undefined` when it is absent. */
export const loadSystem = (cwd: string): DesignSystem | undefined =>
    (real?.loadDesignSystem ?? loadStub)(cwd);

/** The prompt text of a system. */
export const summarize = (system: DesignSystem, maxBytes: number): string =>
    (real?.systemSummary ?? summaryStub)(system, maxBytes);
