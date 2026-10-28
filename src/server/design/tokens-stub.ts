/**
 * A stand-in for stream T's `loadDesignSystem` (`tokens.ts`), with the same signature, until that lands. It finds no
 * system, so checks run without the off-system rules. The integrator replaces the import in `index.ts` with
 * `import { loadDesignSystem } from "./tokens.ts"` and deletes this file.
 */
import type { DesignSystem } from "./system-types.ts";

export function loadDesignSystem(_cwd: string): DesignSystem | undefined {
    return undefined;
}
