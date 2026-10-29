/**
 * The System view's routes (`/api/x/design/c/:conversation/system…`): read the project's design system, write changes to
 * it, check a design against it, publish its documentation page as an artifact, and export it for code.
 */
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { readBundle } from "../../design/bundle.ts";
import { writeExport } from "../../design/files.ts";
import type {
    CheckFinding,
    CheckReport,
    CheckRule,
    DesignSystem,
    SystemChange,
    SystemProblem,
} from "../../design/system-types.ts";
import { assetName, assetType } from "../../http/artifact-assets.ts";
import { zip } from "../../zip.ts";
import {
    ArtifactAssetDoc,
    ArtifactBodyDoc,
    type ArtifactAsset,
    ArtifactsDoc,
    type ArtifactVersion,
    DesignCommentsDoc,
} from "../../docs.ts";
import type { ConversationWebRequest, ExtensionWeb, PocketHost } from "../../host.ts";
import { MAX_ASSET_BYTES, MAX_ASSETS, MAX_ASSETS_BYTES, MAX_BYTES } from "../artifacts.ts";
import {
    type CheckOptions,
    checkDesign,
    fixExactMatches,
    isFixable,
    loadDesignSystem,
    renderSystemDoc,
    writeDesignSystem,
} from "./system-api.ts";

export const LIMITS = {
    set: 500,
    value: 8192,
    guidelines: 16_384,
    modes: 8,
    findings: 300,
} as const;

const MODE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const TOKEN_NAME = /^[A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64}){0,7}$/;
// Names that exist on every object: never a group or a token.
const INHERITED = new Set(["__proto__", "constructor", "prototype"]);

const tokenName = (name: string): boolean =>
    TOKEN_NAME.test(name) && !name.split(".").some((part) => INHERITED.has(part));
const KEY = /^[\w-]{8,64}$/;
const DESIGN_FILES = {
    "ds/tokens.css": "css",
    "ds/tailwind.css": "tailwind",
    "ds/components.css": "components",
} as const;

export const DOCS_ID = "design-system-docs";
const VIEWPORTS = {
    mobile: { width: 390, height: 844 },
    tablet: { width: 820, height: 1180 },
    desktop: { width: 1280, height: 800 },
} as const;
const RULES: readonly CheckRule[] = [
    "off-system-color",
    "off-system-font",
    "off-system-size",
    "contrast",
    "tap-target",
    "overflow",
    "image-alt",
    "heading-order",
    "font-fallback",
    "missing-viewport",
    "missing-pid",
    "focus-visible",
    "reduced-motion",
    "missing-lang",
    "missing-main",
    "form-label",
    "accessible-name",
    "input-zoom",
];

const clip = (value: unknown, max: number): string =>
    typeof value === "string" ? value.replace(/[\p{Cc}\p{Bidi_Control}]/gu, " ").slice(0, max) : "";

const coordinate = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value)
        ? Math.round(Math.max(-1e7, Math.min(1e7, value)) * 10) / 10
        : 0;

function cleanValue(web: Pick<ExtensionWeb, "error">, value: unknown, depth = 0): unknown {
    const bad = () => web.error(400, "A token value is text, a number, a list, or a small object.");

    if (typeof value === "string") {
        return clip(value, 500);
    }

    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw bad();
        }

        return value;
    }

    if (typeof value === "boolean") {
        return value;
    }

    if (depth >= 5) {
        throw bad();
    }

    if (Array.isArray(value)) {
        if (value.length > 32) {
            throw bad();
        }

        return value.map((each) => cleanValue(web, each, depth + 1));
    }

    if (typeof value === "object" && value !== null) {
        const entries = Object.entries(value);

        if (entries.length > 32) {
            throw bad();
        }

        const clean: Record<string, unknown> = {};

        for (const [key, each] of entries) {
            if (!/^[A-Za-z][\w-]{0,39}$/.test(key)) {
                throw bad();
            }

            clean[key] = cleanValue(web, each, depth + 1);
        }

        return clean;
    }

    throw bad();
}

export function cleanChange(
    web: Pick<ExtensionWeb, "error">,
    body: Readonly<Record<string, unknown>>,
) {
    const change: SystemChange = {};

    for (const key of Object.keys(body)) {
        if (!["set", "remove", "modes", "guidelines", "baseRevision"].includes(key)) {
            throw web.error(400, `A save has no “${key.slice(0, 40)}”.`);
        }
    }

    if (body.set !== undefined) {
        if (!Array.isArray(body.set) || body.set.length > LIMITS.set) {
            throw web.error(400, `A save changes up to ${LIMITS.set} tokens.`);
        }

        change.set = body.set.map((each: unknown) => {
            const edit = each as Record<string, unknown> | null;

            if (
                typeof edit !== "object" ||
                edit === null ||
                typeof edit.mode !== "string" ||
                !MODE_NAME.test(edit.mode) ||
                typeof edit.token !== "string" ||
                !tokenName(edit.token)
            ) {
                throw web.error(400, "Each change names a mode and a token.");
            }

            const value = cleanValue(web, edit.value);

            if (JSON.stringify(value).length > LIMITS.value) {
                throw web.error(400, "That value is too large.");
            }

            return { mode: edit.mode, token: edit.token, value };
        });
    }

    if (body.remove !== undefined) {
        if (!Array.isArray(body.remove) || body.remove.length > LIMITS.set) {
            throw web.error(400, `A save gives up to ${LIMITS.set} values back.`);
        }

        change.remove = body.remove.map((each: unknown) => {
            const entry = each as Record<string, unknown> | null;

            if (
                typeof entry !== "object" ||
                entry === null ||
                typeof entry.mode !== "string" ||
                !MODE_NAME.test(entry.mode) ||
                typeof entry.token !== "string" ||
                !tokenName(entry.token)
            ) {
                throw web.error(400, "Each removal names a mode and a token.");
            }

            return { mode: entry.mode, token: entry.token };
        });
    }

    if (body.modes !== undefined) {
        const modes = body.modes as Record<string, unknown> | null;

        if (typeof modes !== "object" || modes === null || Array.isArray(modes)) {
            throw web.error(400, "Modes are a set of names.");
        }

        if (Object.keys(modes).length > LIMITS.modes) {
            throw web.error(400, `A system has up to ${LIMITS.modes} modes.`);
        }

        change.modes = {};

        for (const [name, each] of Object.entries(modes)) {
            if (!MODE_NAME.test(name)) {
                throw web.error(400, "A mode is named in lowercase letters, digits, and hyphens.");
            }

            if (
                each !== null &&
                !(
                    typeof each === "object" &&
                    !Array.isArray(each) &&
                    Object.keys(each).length === 0
                )
            ) {
                throw web.error(400, "A mode is added empty, or removed with null.");
            }

            change.modes[name] = each;
        }
    }

    if (body.guidelines !== undefined) {
        if (typeof body.guidelines !== "string" || body.guidelines.length > LIMITS.guidelines) {
            throw web.error(400, `The guidelines are text up to ${LIMITS.guidelines} characters.`);
        }

        change.guidelines = body.guidelines.replace(/\r\n?/g, "\n").replace(/[^\P{Cc}\n\t]/gu, "");
    }

    if (
        body.baseRevision !== undefined &&
        (typeof body.baseRevision !== "string" || body.baseRevision.length > 64)
    ) {
        throw web.error(400, "The revision is text.");
    }

    if (
        change.set === undefined &&
        change.remove === undefined &&
        change.modes === undefined &&
        change.guidelines === undefined
    ) {
        throw web.error(400, "There is nothing to save.");
    }

    return { change, baseRevision: body.baseRevision as string | undefined };
}

export function revisionOf(system: DesignSystem): string {
    return createHash("sha256")
        .update(
            JSON.stringify([
                system.modes,
                system.schemes,
                system.tokens,
                system.components,
                system.guidelines,
            ]),
        )
        .digest("hex")
        .slice(0, 16);
}

export function viewOf(system: DesignSystem) {
    return {
        name: system.name,
        ...(system.description === undefined ? {} : { description: system.description }),
        modes: system.modes,
        schemes: system.schemes,
        tokens: system.tokens,
        components: system.components,
        guidelines: system.guidelines,
        problems: system.problems,
        ...(system.notes === undefined ? {} : { notes: system.notes }),
        ...(system.overrides === undefined ? {} : { overrides: system.overrides }),
        componentsCss: system.compiled.components,
        dist: {
            "tokens.css": Buffer.byteLength(system.compiled.css),
            "tailwind.css": Buffer.byteLength(system.compiled.tailwind),
            "tokens.resolved.json": Buffer.byteLength(system.compiled.json),
            ...(system.compiled.studio === undefined
                ? {}
                : { "tokens.studio.json": Buffer.byteLength(system.compiled.studio) }),
            ...(system.compiled.names === undefined
                ? {}
                : { "names.md": Buffer.byteLength(system.compiled.names) }),
            "components.css": Buffer.byteLength(system.compiled.components),
        },
        revision: revisionOf(system),
    };
}

export type CheckedReport = CheckReport & {
    accepted: CheckFinding[];
    order: string[];
};

// The report holds text from the page: every field is cut to a fixed shape.
export function cleanReport(
    report: CheckReport,
    system?: DesignSystem,
    mode?: string,
    accepted: ReadonlySet<string> = new Set(),
): CheckedReport {
    const open: CheckFinding[] = [];
    const set: CheckFinding[] = [];
    const order: string[] = [];
    const listed = (value: unknown): unknown[] =>
        Array.isArray(value) ? value.slice(0, 2000) : [];
    const engines = (report as { accepted?: unknown } | undefined)?.accepted;

    for (const [each, apart] of [
        ...listed(report?.findings).map((one) => [one, false] as const),
        ...listed(engines).map((one) => [one, true] as const),
    ]) {
        const finding = cleanFinding(each as CheckFinding, system, mode);

        if (finding === undefined) {
            continue;
        }

        if (finding.id !== undefined && order.length < LIMITS.findings * 2) {
            order.push(finding.id);
        }

        const into = apart || (finding.id !== undefined && accepted.has(finding.id)) ? set : open;

        if (into.length < LIMITS.findings) {
            into.push(finding);
        }
    }

    const byRule: Partial<Record<CheckRule, number>> = {};
    const left = report?.summary?.notJudged?.contrast;

    for (const each of open) {
        byRule[each.rule] = (byRule[each.rule] ?? 0) + 1;
    }

    return {
        order,
        viewport: {
            width: Math.round(coordinate(report?.viewport?.width)),
            height: Math.round(coordinate(report?.viewport?.height)),
        },
        colorScheme: report?.colorScheme === "dark" ? "dark" : "light",
        ...(typeof report?.mode === "string" && report.mode !== ""
            ? { mode: clip(report.mode, 64) }
            : {}),
        findings: open,
        accepted: set,
        summary: {
            errors: open.filter((each) => each.level === "error").length,
            warnings: open.filter((each) => each.level === "warning").length,
            elements: Math.max(0, Math.round(coordinate(report?.summary?.elements))),
            byRule,
            ...(set.length > 0 ? { accepted: set.length } : {}),
            ...(left !== undefined && coordinate(left.count) > 0
                ? {
                      notJudged: {
                          contrast: {
                              count: Math.round(coordinate(left.count)),
                              elements: (Array.isArray(left.elements) ? left.elements : [])
                                  .slice(0, 8)
                                  .map((one: unknown) => clip(one, 500)),
                          },
                      },
                  }
                : {}),
        },
        withoutSystem: report?.withoutSystem === true,
    };
}

function cleanFinding(
    each: CheckFinding,
    system: DesignSystem | undefined,
    mode: string | undefined,
): CheckFinding | undefined {
    if (!RULES.includes(each?.rule)) {
        return undefined;
    }

    const rect = each.rect;
    const fix = each.fix;

    const fixable =
        (each as { fixable?: unknown }).fixable === true || isFixable(each, system, mode);

    return {
        ...(typeof each.id === "string" ? { id: clip(each.id, 60) } : {}),
        ...(Array.isArray(each.elements) && each.elements.length > 1
            ? {
                  elements: each.elements.slice(0, 12).map((item) => ({
                      selector: clip(item?.selector, 500),
                      ...(typeof item?.pid === "string" && item.pid !== ""
                          ? { pid: clip(item.pid, 200) }
                          : {}),
                      ...(typeof item?.rect === "object" && item.rect !== null
                          ? {
                                rect: {
                                    x: coordinate(item.rect.x),
                                    y: coordinate(item.rect.y),
                                    width: coordinate(item.rect.width),
                                    height: coordinate(item.rect.height),
                                },
                            }
                          : {}),
                  })),
              }
            : {}),
        ...(typeof fix === "object" &&
        fix !== null &&
        ["color", "length", "font"].includes(fix.kind) &&
        Array.isArray(fix.properties)
            ? {
                  fix: {
                      kind: fix.kind,
                      properties: fix.properties.slice(0, 20).map((one) => clip(one, 60)),
                      literal: clip(fix.literal, 300),
                      token: clip(fix.token, 200),
                      cssVar: clip(fix.cssVar, 200),
                      mode: clip(fix.mode, 64),
                  },
              }
            : {}),
        rule: each.rule,
        level: each.level === "error" ? "error" : "warning",
        selector: clip(each.selector, 500),
        ...(typeof each.pid === "string" && each.pid !== "" ? { pid: clip(each.pid, 200) } : {}),
        ...(typeof each.value === "string" ? { value: clip(each.value, 200) } : {}),
        ...(typeof each.suggestion === "string" ? { suggestion: clip(each.suggestion, 300) } : {}),
        message: clip(each.message, 400),
        ...(fixable ? { fixable: true } : {}),
        ...(typeof rect === "object" && rect !== null
            ? {
                  rect: {
                      x: coordinate(rect.x),
                      y: coordinate(rect.y),
                      width: coordinate(rect.width),
                      height: coordinate(rect.height),
                  },
              }
            : {}),
    };
}

function legacySize(cwd: string): number | null {
    try {
        // Links are refused: only a plain folder and file count.
        if (!lstatSync(join(cwd, ".pi")).isDirectory()) {
            return null;
        }

        const info = lstatSync(join(cwd, ".pi", "design-system.md"));

        return info.isFile() ? info.size : null;
    } catch {
        return null;
    }
}

// The engine's own message is written for Pi ("Fix them and call again"), so the problems are shown instead.
export function refusal(error: unknown): { failed: string; problems: SystemProblem[] } {
    const list = (error as { problems?: unknown } | null)?.problems;
    const problems: SystemProblem[] = (Array.isArray(list) ? list : [])
        .slice(0, 20)
        .filter(
            (each) => typeof each === "object" && each !== null && typeof each.message === "string",
        )
        .map((each) => ({
            level: each.level === "warning" ? "warning" : "error",
            message: clip(each.message, 400),
            ...(typeof each.file === "string" ? { file: clip(each.file, 100) } : {}),
            ...(typeof each.token === "string" ? { token: clip(each.token, 200) } : {}),
        }));
    const failed =
        problems.length > 0
            ? `Not saved: ${problems
                  .slice(0, 3)
                  .map((each) => each.message.replace(/\s+/g, " ").trim())
                  .join(" ")}${problems.length > 3 ? ` (and ${problems.length - 3} more)` : ""}`
            : error instanceof Error
              ? clip(error.message, 600)
              : "The save failed.";

    return { failed: failed.slice(0, 900), problems };
}

export function systemRoutes(web: ExtensionWeb, host: PocketHost): void {
    const view = { conversation: "conversation", access: "view" } as const;
    const steer = { conversation: "conversation", access: "steer" } as const;

    // One save at a time for each folder: a save reads the revision and writes, and no other may come between.
    const queues = new Map<string, Promise<unknown>>();

    const exclusive = async <T>(cwd: string, work: () => Promise<T> | T): Promise<T> => {
        const before = queues.get(cwd) ?? Promise.resolve();
        const run = before.then(work, work);
        const tail = run.catch(() => undefined);

        queues.set(cwd, tail);
        void tail.then(() => queues.get(cwd) === tail && queues.delete(cwd));

        return run;
    };

    const folderOf = (request: ConversationWebRequest): string => {
        const cwd = request.conversation.cwd;

        if (!cwd) {
            throw web.error(400, "This session has no folder.");
        }

        return cwd;
    };

    const load = async (cwd: string): Promise<DesignSystem | undefined> => {
        try {
            return await loadDesignSystem(cwd);
        } catch (error) {
            throw web.error(
                400,
                error instanceof Error ? error.message : "The design system could not be read.",
            );
        }
    };

    const changed = (conversation: number) => web.send("system", { conversation });

    web.conversationRoute(
        "GET",
        "c/:conversation/system",
        async (request) => {
            const cwd = folderOf(request);
            const system = await load(cwd);

            if (system === undefined) {
                return { system: null, legacy: legacySize(cwd) };
            }

            const revision = revisionOf(system);

            return request.query.get("revision") === revision
                ? { unchanged: true, revision }
                : { system: viewOf(system), legacy: null };
        },
        view,
    );

    web.conversationRoute(
        "POST",
        "c/:conversation/system",
        async (request) => {
            const { change, baseRevision } = cleanChange(web, request.body);
            const cwd = folderOf(request);

            const result = await exclusive(cwd, async () => {
                const current = await load(cwd);

                if (current === undefined) {
                    throw web.error(404, "There is no design system yet.");
                }

                if (baseRevision !== undefined && baseRevision !== revisionOf(current)) {
                    throw web.error(
                        409,
                        "The design system changed since you opened it. Load it again; your edits stay.",
                    );
                }

                // `{}` for a mode that is there would empty its file, and the default mode is the tokens file itself.
                for (const [mode, body] of Object.entries(change.modes ?? {})) {
                    if (body === null && !current.modes.includes(mode)) {
                        throw web.error(400, "There is no such mode.");
                    }

                    if (body === null && mode === current.modes[0]) {
                        throw web.error(
                            400,
                            "The default mode is the tokens file: it cannot be removed.",
                        );
                    }

                    if (body !== null && current.modes.includes(mode)) {
                        throw web.error(400, "There is a mode by that name.");
                    }
                }

                // The engine would make a new token or mode file of a name that is not there.
                for (const entry of change.set ?? []) {
                    if (!current.modes.includes(entry.mode)) {
                        throw web.error(400, `There is no mode “${entry.mode}”.`);
                    }

                    if (!current.tokens.some((token) => token.name === entry.token)) {
                        throw web.error(400, `There is no token “${entry.token}”.`);
                    }
                }

                // In the default mode a removal would delete the token, and the engine would take that as meant.
                for (const entry of change.remove ?? []) {
                    if (!current.modes.includes(entry.mode)) {
                        throw web.error(400, `There is no mode “${entry.mode}”.`);
                    }

                    if (entry.mode === current.modes[0]) {
                        throw web.error(
                            400,
                            "The default mode has the values: a token is not given back there.",
                        );
                    }

                    if (!(current.overrides?.[entry.mode] ?? []).includes(entry.token)) {
                        throw web.error(
                            400,
                            `The mode “${entry.mode}” does not set “${entry.token}” itself.`,
                        );
                    }
                }

                try {
                    return { saved: await writeDesignSystem(cwd, change) };
                } catch (error) {
                    return refusal(error);
                }
            });

            if ("failed" in result) {
                return { ok: false, error: result.failed, problems: result.problems };
            }

            changed(request.conversation.id);

            return { ok: true, system: viewOf(result.saved), legacy: null };
        },
        steer,
    );

    const checkTarget = async (request: ConversationWebRequest) => {
        const id = typeof request.body.id === "string" ? request.body.id : "";
        const version = request.body.version;
        const scheme = request.body.colorScheme;
        const mode = request.body.mode;
        const size = request.body.viewport ?? "mobile";

        if (
            version !== undefined &&
            (typeof version !== "number" || !Number.isSafeInteger(version))
        ) {
            throw web.error(400, "Choose a version.");
        }

        if (scheme !== undefined && scheme !== "light" && scheme !== "dark") {
            throw web.error(400, "Choose light or dark.");
        }

        if (mode !== undefined && (typeof mode !== "string" || mode === "" || mode.length > 100)) {
            throw web.error(400, "Choose a mode of the design system.");
        }

        if (typeof size !== "string" || !Object.hasOwn(VIEWPORTS, size)) {
            throw web.error(400, "Choose mobile, tablet, or desktop.");
        }

        const cwd = folderOf(request);
        const system = await load(cwd);

        if (mode !== undefined && system !== undefined && !system.modes.includes(mode)) {
            throw web.error(
                400,
                `The design system has no mode "${mode.slice(0, 40)}". Modes: ${system.modes.join(", ")}.`,
            );
        }

        const checked = mode !== undefined && system !== undefined ? mode : undefined;
        const colorScheme =
            scheme ?? (checked === undefined ? undefined : system?.schemes[checked]);
        const options: CheckOptions = {
            viewport: VIEWPORTS[size as keyof typeof VIEWPORTS],
            ...(colorScheme === undefined ? {} : { colorScheme }),
            ...(checked === undefined ? {} : { mode: checked }),
        };

        return { id, version: version as number | undefined, options, system, mode: checked };
    };

    const acceptedOf = async (
        request: ConversationWebRequest,
        id: string,
    ): Promise<Set<string>> => {
        const doc = await request.snapshot(
            DesignCommentsDoc,
            request.conversation.id,
            request.context,
        );
        const item = Object.hasOwn(doc?.items ?? {}, id) ? doc!.items[id] : undefined;

        return new Set(Object.keys(item?.accepted ?? {}));
    };

    web.conversationRoute(
        "POST",
        "c/:conversation/system/check",
        async (request) => {
            const { id, version, options, system, mode } = await checkTarget(request);

            try {
                const bundle = await readBundle(
                    host,
                    request.snapshot,
                    request.conversation.id,
                    id,
                    version,
                    request.context,
                );
                const accepted = await acceptedOf(request, id);
                const asked: CheckOptions & { accepted?: readonly string[] } = {
                    ...options,
                    ...(accepted.size > 0 ? { accepted: [...accepted] } : {}),
                };
                const report = await checkDesign(bundle, system, asked, host, request.signal);

                return {
                    report: cleanReport(report, system, mode, accepted),
                    id,
                    version: bundle.version,
                };
            } catch (error) {
                if (request.signal.aborted) {
                    throw error;
                }

                throw web.error(
                    400,
                    error instanceof Error ? error.message.slice(0, 300) : "The check failed.",
                );
            }
        },
        steer,
    );

    // The key makes a repeat of the same tap find the version it made.
    web.conversationRoute(
        "POST",
        "c/:conversation/system/fix",
        async (request) => {
            const key = request.body.key;

            if (typeof key !== "string" || !KEY.test(key)) {
                throw web.error(400, "A fix needs a key.");
            }

            const { id, version, options, system } = await checkTarget(request);

            if (system === undefined) {
                throw web.error(404, "There is no design system yet.");
            }

            const callId = `design-fix:${key}`;
            const index = await request.snapshot(
                ArtifactsDoc,
                request.conversation.id,
                request.context,
            );
            const known =
                index !== undefined && Object.hasOwn(index.items, id) ? index.items[id] : undefined;
            const again = known?.versions.find((each) => each.callId === callId);

            if (again !== undefined) {
                return { id, version: again.version, fixed: 0, again: true };
            }

            if (system.problems.some((problem) => problem.level === "error")) {
                throw web.error(409, "Fix the errors in the design system first.");
            }

            let result;
            let from;

            try {
                const bundle = await readBundle(
                    host,
                    request.snapshot,
                    request.conversation.id,
                    id,
                    version,
                    request.context,
                );
                const accepted = await acceptedOf(request, id);
                const asked: CheckOptions & { accepted?: readonly string[] } = {
                    ...options,
                    ...(accepted.size > 0 ? { accepted: [...accepted] } : {}),
                };
                const report = await checkDesign(bundle, system, asked, host, request.signal);

                from = bundle.version;
                result = fixExactMatches(bundle, system, report, { mode: options.mode, accepted });

                if (result.fixed > 0 && Buffer.byteLength(result.content) > MAX_BYTES) {
                    throw web.error(400, "The page is too large.");
                }
            } catch (error) {
                if (request.signal.aborted) {
                    throw error;
                }

                if (error instanceof Error && "status" in error) {
                    throw error;
                }

                throw web.error(
                    400,
                    error instanceof Error ? error.message.slice(0, 300) : "The fix failed.",
                );
            }

            if (result.fixed === 0) {
                throw web.error(
                    409,
                    "Nothing in this version is an exact match that one tap can fix.",
                );
            }

            const content = result.content;
            // The version's `ds/` files are a snapshot and may not define these tokens yet: the new version gets the current ones.
            const fresh = new Map<string, { asset: ArtifactAsset; bytes: Buffer }>();

            for (const [name, key] of Object.entries(DESIGN_FILES)) {
                const bytes = Buffer.from(system.compiled[key], "utf8");

                fresh.set(name, {
                    asset: {
                        hash: createHash("sha256").update(bytes).digest("hex"),
                        size: bytes.length,
                        type: assetType(name),
                    },
                    bytes,
                });
            }

            const made = await request.commit(async (tx) => {
                const items = await tx.doc(ArtifactsDoc, request.conversation.id);
                const current = Object.hasOwn(items.items, id) ? items.items[id] : undefined;

                if (current === undefined || current.type !== "html") {
                    throw web.error(404, "No such design.");
                }

                const done = current.versions.find((each) => each.callId === callId);

                if (done !== undefined) {
                    return done.version;
                }

                const original = current.versions.find((each) => each.version === from);

                if (original === undefined) {
                    throw web.error(404, "That version is not there.");
                }

                const next = current.versions.at(-1)!.version + 1;
                const { inline: _inline, ...copy } = original;
                const assets = { ...copy.assets };

                for (const [name, each] of fresh) {
                    if (Object.hasOwn(assets, name)) {
                        await tx.doc(ArtifactAssetDoc, each.asset.hash, {
                            base64: each.bytes.toString("base64"),
                        });
                        assets[name] = each.asset;
                    }
                }

                current.versions.push({
                    ...copy,
                    ...(copy.assets === undefined ? {} : { assets }),
                    version: next,
                    callId,
                    size: Buffer.byteLength(content),
                    createdAt: Date.now(),
                });

                const stored = await tx.doc(
                    ArtifactBodyDoc,
                    request.conversation.id,
                    `${id}@${next}`,
                    { content },
                );

                if (stored.content !== content) {
                    stored.content = content;
                }

                return next;
            });

            return { id, version: made, fixed: result.fixed, fixes: result.fixes.slice(0, 20) };
        },
        steer,
    );

    // The key makes a repeat of the same tap find the version it made.
    web.conversationRoute(
        "POST",
        "c/:conversation/system/docs",
        async (request) => {
            const key = request.body.key;

            if (typeof key !== "string" || !KEY.test(key)) {
                throw web.error(400, "Publishing needs a key.");
            }

            const system = await load(folderOf(request));

            if (system === undefined) {
                throw web.error(404, "There is no design system yet.");
            }

            if (system.problems.some((problem) => problem.level === "error")) {
                throw web.error(409, "Fix the errors in the design system first.");
            }

            const doc = renderSystemDoc(system);
            const callId = `design-system-docs:${key}`;
            const prepared = new Map<string, { asset: ArtifactAsset; bytes: Buffer }>();
            let total = 0;

            if (Buffer.byteLength(doc.html) > MAX_BYTES) {
                throw web.error(400, "The documentation page is too large.");
            }

            if (doc.assets.length > MAX_ASSETS) {
                throw web.error(400, "The documentation page has too many files.");
            }

            for (const entry of doc.assets) {
                const bytes = Buffer.from(entry.content, "utf8");

                total += bytes.length;

                if (
                    !assetName(entry.name) ||
                    prepared.has(entry.name) ||
                    bytes.length > MAX_ASSET_BYTES ||
                    total > MAX_ASSETS_BYTES
                ) {
                    throw web.error(400, "A file of the documentation page is not valid.");
                }

                prepared.set(entry.name, {
                    asset: {
                        hash: createHash("sha256").update(bytes).digest("hex"),
                        size: bytes.length,
                        type: assetType(entry.name),
                    },
                    bytes,
                });
            }

            const version = await request.commit(async (tx) => {
                const index = await tx.doc(ArtifactsDoc, request.conversation.id);
                const current = Object.hasOwn(index.items, DOCS_ID)
                    ? index.items[DOCS_ID]
                    : undefined;

                if (current !== undefined && current.type !== "html") {
                    throw web.error(409, `The artifact ${DOCS_ID} is not a page.`);
                }

                const again = current?.versions.find((each) => each.callId === callId);

                if (again !== undefined) {
                    return again.version;
                }

                for (const { asset, bytes } of prepared.values()) {
                    await tx.doc(ArtifactAssetDoc, asset.hash, {
                        base64: bytes.toString("base64"),
                    });
                }

                const next = (current?.versions.at(-1)?.version ?? 0) + 1;
                const assets = Object.fromEntries(
                    [...prepared].map(([name, each]) => [name, each.asset]),
                );
                const record = {
                    version: next,
                    taskId: 0,
                    callId,
                    size: Buffer.byteLength(doc.html),
                    createdAt: Date.now(),
                    ...(prepared.size > 0 ? { assets } : {}),
                } as unknown as ArtifactVersion;
                const title = `${system.name} design system`.slice(0, 100);

                if (current === undefined) {
                    index.items[DOCS_ID] = { title, type: "html", versions: [record] };
                } else {
                    current.title = title;
                    current.versions.push(record);
                }

                const body = await tx.doc(
                    ArtifactBodyDoc,
                    request.conversation.id,
                    `${DOCS_ID}@${next}`,
                    {
                        content: doc.html,
                    },
                );

                if (body.content !== doc.html) {
                    body.content = doc.html;
                }

                return next;
            });

            return { id: DOCS_ID, version };
        },
        steer,
    );

    web.conversationRoute(
        "POST",
        "c/:conversation/system/export",
        async (request) => {
            const cwd = folderOf(request);
            const system = await load(cwd);

            if (system === undefined) {
                throw web.error(404, "There is no design system yet.");
            }

            if (system.problems.some((problem) => problem.level === "error")) {
                throw web.error(409, "Fix the errors in the design system first.");
            }

            const slug =
                system.name
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-+|-+$/g, "")
                    .slice(0, 40) || "design-system";
            const name = `${slug}-tokens.zip`;
            const files: [string, string][] = [
                ["tokens.css", system.compiled.css],
                ["tailwind.css", system.compiled.tailwind],
                ...Object.entries(system.compiled.modes ?? {}).map(
                    ([mode, text]): [string, string] => [`tokens.${mode}.resolved.json`, text],
                ),
                ...(system.compiled.studio === undefined
                    ? []
                    : ([["tokens.studio.json", system.compiled.studio]] as [string, string][])),
                ...(system.compiled.names === undefined
                    ? []
                    : ([["names.md", system.compiled.names]] as [string, string][])),
                ["tokens.resolved.json", system.compiled.json],
                ["components.css", system.compiled.components],
            ];

            try {
                const bytes = zip(
                    files.map(([file, text]) => ({ name: file, bytes: Buffer.from(text) })),
                );
                const path = await writeExport(cwd, `exports/${name}`, bytes);

                return { path, relative: `exports/${name}`, name, size: bytes.length };
            } catch (error) {
                throw web.error(
                    400,
                    error instanceof Error ? error.message.slice(0, 300) : "The export failed.",
                );
            }
        },
        steer,
    );
}
