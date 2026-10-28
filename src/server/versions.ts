/** Pi Pocket's versions, compared: the gallery's entries and theme folders both name the oldest they work with. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ROOT } from "./config.ts";

/** Pi Pocket's own package: its version, and the packages a drop-in can import by name. */
export const pocketPackage: { version?: string; dependencies?: Record<string, string> } = (() => {
    try {
        return JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")) as {
            version?: string;
            dependencies?: Record<string, string>;
        };
    } catch {
        return {};
    }
})();

/** This Pi Pocket's version, from its package. */
export const pocketVersion = (): string => pocketPackage.version ?? "0.0.0";

/** A Pi Pocket version: `0.14.0`. */
export const POCKET_VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

/** The parts of a Pi Pocket version, `0.14.0`, or undefined. Pre-releases count as their release (`0.14.0-beta.3`). */
export function versionParts(version: string): [number, number, number] | undefined {
    const match = POCKET_VERSION.exec(version.replace(/[-+].*$/, ""));

    return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Whether Pi Pocket `version` is `minimum` or newer. */
export function atLeast(version: string, minimum: string): boolean {
    const have = versionParts(version);
    const need = versionParts(minimum);

    if (have === undefined || need === undefined) {
        return false;
    }

    for (let at = 0; at < 3; at++) {
        if (have[at] !== need[at]) {
            return have[at]! > need[at]!;
        }
    }

    return true;
}

/**
 * A version as updates read it: `0.27.0`, or a pre-release of it, `0.27.0-beta.1` (build metadata after `+` is left
 * out).
 */
const RELEASE_VERSION =
    /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** The parts of a version with its pre-release, or undefined. */
export function releaseParts(
    version: string,
): { numbers: [number, number, number]; pre: string[] } | undefined {
    const match = RELEASE_VERSION.exec(version.replace(/\+.*$/, ""));

    return match === null
        ? undefined
        : {
              numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
              pre: match[4] === undefined ? [] : match[4].split("."),
          };
}

/**
 * Order two versions as updates need it (semver's order, for the forms Pi Pocket uses): `0.27.0-beta.2` is newer than
 * `0.27.0-beta.1`, `0.27.0` is newer than any `0.27.0-beta.N`, and `0.27.0-beta.1` is newer than `0.26.0`. A negative
 * number, 0, or a positive number; undefined when either is not a version. `versionParts` and `atLeast` stay as they
 * were: they treat a pre-release as its release, which is what the API versions of extensions and themes need.
 */
export function compareReleases(a: string, b: string): number | undefined {
    const left = releaseParts(a);
    const right = releaseParts(b);

    if (left === undefined || right === undefined) {
        return undefined;
    }

    for (let at = 0; at < 3; at++) {
        if (left.numbers[at] !== right.numbers[at]) {
            return left.numbers[at]! - right.numbers[at]!;
        }
    }

    // A release comes after its pre-releases.
    if (left.pre.length === 0 || right.pre.length === 0) {
        return right.pre.length - left.pre.length;
    }

    for (let at = 0; at < Math.min(left.pre.length, right.pre.length); at++) {
        const one = left.pre[at]!;
        const other = right.pre[at]!;

        if (one === other) {
            continue;
        }

        const oneNumber = /^\d+$/.test(one);
        const otherNumber = /^\d+$/.test(other);

        if (oneNumber && otherNumber) {
            return Number(one) - Number(other);
        }

        if (oneNumber !== otherNumber) {
            return oneNumber ? -1 : 1;
        }

        return one < other ? -1 : 1;
    }

    return left.pre.length - right.pre.length;
}
