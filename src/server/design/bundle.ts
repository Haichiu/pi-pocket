/** Snapshot-based bundle access. The optional host reader connects to stream A after integration. */
import type { Context } from "@earendil-works/chord";
import type { ConversationId, DocumentReader } from "@earendil-works/pi-durable";
import { ArtifactBodyDoc, ArtifactsDoc, type ArtifactMeta } from "../docs.ts";
import type { PocketHost } from "../host.ts";

export type DesignBundle = {
    meta: ArtifactMeta;
    version: number;
    content: string;
    assets: { name: string; type: string; bytes: Buffer }[];
};

export async function readBundle(
    host: PocketHost,
    snapshot: DocumentReader["snapshot"],
    conversation: ConversationId,
    id: string,
    version: number | undefined,
    context: Context,
): Promise<DesignBundle> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
        throw new Error("Use the artifact's kebab-case id.");
    }

    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) {
        throw new Error("Version must be a positive integer.");
    }

    const reader = (
        host as PocketHost & {
            artifactBundle?: (
                conversation: ConversationId,
                artifact: string,
                version?: number,
            ) => Promise<DesignBundle>;
        }
    ).artifactBundle;

    if (reader !== undefined) {
        const bundle = await reader(conversation, id, version);

        if (bundle.meta.type !== "html") {
            throw new Error("Design tools require an HTML artifact.");
        }

        return bundle;
    }

    // Local stub until A's bundle reader is available on the host. Never silently omit stored assets.
    const index = await snapshot(ArtifactsDoc, conversation, context);
    const meta =
        index !== undefined && Object.hasOwn(index.items, id) ? index.items[id] : undefined;
    const record = meta?.versions.find(
        (item) => item.version === (version ?? meta.versions.at(-1)?.version),
    );

    if (meta === undefined || record === undefined) {
        throw new Error("The artifact or version does not exist.");
    }

    if (meta.type !== "html") {
        throw new Error("Design tools require an HTML artifact.");
    }

    if (Object.keys((record as typeof record & { assets?: object }).assets ?? {}).length > 0) {
        throw new Error("Artifact bundle reading needs the integrated artifactBundle host reader.");
    }

    const body = await snapshot(ArtifactBodyDoc, conversation, `${id}@${record.version}`, context);

    if (body === undefined) {
        throw new Error("The artifact content is missing.");
    }

    return { meta, version: record.version, content: body.content, assets: [] };
}
