/**
 * Writes `golden/tokens.css` from the lint system's DTCG files with the bench's own reader. Run it after you change
 * `.pi/design/tokens*.json`: `node test/design-system-bench/lint/system/make-golden.ts`. The bench test checks that the
 * file is current.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { goldenCss, readFlat } from "../../lib/system.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** The golden CSS text for the lint system. */
export function makeGolden(): string {
    return goldenCss(readFlat(join(here, ".pi", "design")));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    mkdirSync(join(here, "golden"), { recursive: true });
    writeFileSync(join(here, "golden", "tokens.css"), makeGolden());
}
