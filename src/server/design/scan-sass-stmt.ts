import { Unsupported } from "./scan-sass-expr.ts";

export interface Stmt {
    line: number;
    head: string;
    body: Stmt[] | undefined;
    raw: string;
}

export const LIMITS = {
    statements: 20_000,
    depth: 24,
    ticks: 400_000,
    iterations: 6_000,
    output: 600_000,
} as const;

export function statementsOf(source: string, firstLine: number, depth = 0): Stmt[] {
    if (depth > LIMITS.depth) {
        throw new Unsupported("nested too deep");
    }

    const out: Stmt[] = [];
    let at = 0;
    let line = firstLine;
    let head = "";
    let blank = true;
    let headLine = line;
    let headStart = 0;
    let parens = 0;

    const push = (body: Stmt[] | undefined, end: number) => {
        const trimmed = head.trim();

        if (trimmed !== "" || body !== undefined) {
            out.push({
                line: headLine,
                head: trimmed,
                body,
                raw: source.slice(headStart, end).trim(),
            });
        }

        head = "";
        blank = true;
        headStart = end;
    };

    while (at < source.length) {
        const char = source[at]!;

        if (char === "\n") {
            line += 1;
            head += char;
            at += 1;

            continue;
        }

        if (blank && !/\s/.test(char)) {
            headLine = line;
            headStart = at;
            blank = false;
        }

        if (char === "/" && source[at + 1] === "/") {
            while (at < source.length && source[at] !== "\n") {
                at += 1;
            }

            continue;
        }

        if (char === "/" && source[at + 1] === "*") {
            const end = source.indexOf("*/", at + 2);
            const stop = end === -1 ? source.length : end + 2;

            line += (source.slice(at, stop).match(/\n/g) ?? []).length;
            at = stop;

            continue;
        }

        if (char === '"' || char === "'") {
            let index = at + 1;

            while (index < source.length && source[index] !== char) {
                if (source[index] === "\\") {
                    index += 1;
                } else if (source[index] === "#" && source[index + 1] === "{") {
                    let level = 0;

                    for (; index < source.length; index++) {
                        level += source[index] === "{" ? 1 : source[index] === "}" ? -1 : 0;

                        if (level === 0 && source[index] === "}") {
                            break;
                        }
                    }
                }

                index += 1;
            }

            head += source.slice(at, index + 1);
            line += (source.slice(at, index + 1).match(/\n/g) ?? []).length;
            at = index + 1;

            continue;
        }

        if (char === "#" && source[at + 1] === "{") {
            let level = 0;
            let index = at + 1;

            for (; index < source.length; index++) {
                level += source[index] === "{" ? 1 : source[index] === "}" ? -1 : 0;

                if (level === 0) {
                    break;
                }
            }

            head += source.slice(at, index + 1);
            line += (source.slice(at, index + 1).match(/\n/g) ?? []).length;
            at = index + 1;

            continue;
        }

        if (char === "(" || char === "[") {
            parens += 1;
        } else if (char === ")" || char === "]") {
            parens = Math.max(0, parens - 1);
        }

        if (char === "{" && parens === 0) {
            let level = 1;
            let index = at + 1;
            let inner = at;

            for (; index < source.length && level > 0; index++) {
                const each = source[index]!;

                if (each === '"' || each === "'") {
                    index += 1;

                    while (index < source.length && source[index] !== each) {
                        index += source[index] === "\\" ? 2 : 1;
                    }
                } else if (each === "/" && source[index + 1] === "*") {
                    const end = source.indexOf("*/", index + 2);

                    index = end === -1 ? source.length : end + 1;
                } else if (each === "/" && source[index + 1] === "/") {
                    while (index < source.length && source[index] !== "\n") {
                        index += 1;
                    }

                    index -= 1;
                } else if (each === "{") {
                    level += 1;
                } else if (each === "}") {
                    level -= 1;
                }

                inner = index;
            }

            const innerText = source.slice(at + 1, level === 0 ? inner : source.length);

            push(statementsOf(innerText, line, depth + 1), inner + 1);
            line += (source.slice(at, inner + 1).match(/\n/g) ?? []).length;
            at = inner + 1;

            continue;
        }

        if (char === ";" && parens === 0) {
            push(undefined, at + 1);
            at += 1;

            continue;
        }

        if (char === "}") {
            at += 1;

            continue;
        }

        head += char;
        at += 1;
    }

    push(undefined, source.length);

    if (out.length > LIMITS.statements) {
        throw new Unsupported("too many statements");
    }

    return out;
}

export function splitTop(source: string, separator: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let buffer = "";

    for (let at = 0; at < source.length; at++) {
        const char = source[at]!;

        if (char === '"' || char === "'") {
            const end = source.indexOf(char, at + 1);
            const stop = end === -1 ? source.length : end + 1;

            buffer += source.slice(at, stop);
            at = stop - 1;
        } else if (char === "(" || char === "[" || char === "{") {
            depth += 1;
            buffer += char;
        } else if (char === ")" || char === "]" || char === "}") {
            depth -= 1;
            buffer += char;
        } else if (char === separator && depth === 0) {
            parts.push(buffer);
            buffer = "";
        } else {
            buffer += char;
        }
    }

    parts.push(buffer);

    return parts;
}

export function dependenciesOf(source: string): string[] {
    return [...source.matchAll(/@(?:use|import|forward)\s+((?:["'][^"']+["']\s*,?\s*)+)/g)].flatMap(
        (match) => [...match[1]!.matchAll(/["']([^"']+)["']/g)].map((each) => each[1]!),
    );
}
