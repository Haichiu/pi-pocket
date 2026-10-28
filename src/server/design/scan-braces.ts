/**
 * Brace matching in the text of a script (stream T): the object around a place, the end of an object, and the keys at its
 * top level. Strings and template literals are skipped. The reads are bounded: untrusted text.
 */

/** The index after the bracket that closes the one at `open` (`{`, `[`), or undefined when it does not close in reach. */
export function closeOf(text: string, open: number): number | undefined {
    const start = text[open];
    const close = start === "[" ? "]" : "}";
    let depth = 0;
    let quote = "";

    for (let at = open; at < Math.min(text.length, open + 80_000); at++) {
        const char = text[at]!;

        if (quote !== "") {
            if (char === "\\") {
                at += 1;
            } else if (char === quote) {
                quote = "";
            }
        } else if (char === '"' || char === "'" || char === "`") {
            quote = char;
        } else if (char === start) {
            depth += 1;
        } else if (char === close && --depth === 0) {
            return at + 1;
        }
    }

    return undefined;
}

/** The `{` that opens the object around `index`, or undefined. */
export function openAround(text: string, index: number): number | undefined {
    let depth = 0;

    for (let at = index - 1; at >= Math.max(0, index - 20_000); at--) {
        const char = text[at]!;

        if (char === "}") {
            depth += 1;
        } else if (char === "{") {
            if (depth === 0) {
                return at;
            }

            depth -= 1;
        }
    }

    return undefined;
}

/** Where the value of `key` starts, among the top-level keys of the object that spans `open` to `end`; or undefined. */
export function topLevelAt(
    text: string,
    open: number,
    end: number,
    key: string,
): number | undefined {
    let depth = 0;
    let quote = "";

    for (let at = open; at < end; at++) {
        const char = text[at]!;

        if (quote !== "") {
            if (char === "\\") {
                at += 1;
            } else if (char === quote) {
                quote = "";
            }

            continue;
        }

        if (depth === 1 && !/[\w$.]/.test(text[at - 1] ?? "")) {
            const quoted = char === '"' || char === "'";
            const from = quoted ? at + 1 : at;

            if (text.startsWith(key, from)) {
                const after = /^["']?\s*:\s*/.exec(
                    text.slice(from + key.length, from + key.length + 40),
                );

                if (after !== null && (quoted || !/[\w$]/.test(text[from + key.length] ?? ""))) {
                    return from + key.length + after[0].length;
                }
            }
        }

        if (char === '"' || char === "'" || char === "`") {
            quote = char;
        } else if (char === "{" || char === "[" || char === "(") {
            depth += 1;
        } else if (char === "}" || char === "]" || char === ")") {
            depth -= 1;
        }
    }

    return undefined;
}

/** The raw text of the value of a top-level key, up to the comma or the line end; or undefined. */
export function topLevelValue(
    text: string,
    open: number,
    end: number,
    key: string,
): string | undefined {
    const at = topLevelAt(text, open, end, key);

    return at === undefined ? undefined : /^[^,\n]*/.exec(text.slice(at, at + 400))?.[0];
}
