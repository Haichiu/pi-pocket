/** The injected, committed artifact bundle reader shared with the Design workspace. */
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ArtifactMeta } from "../docs.ts";

export type DesignBundle = {
    meta: ArtifactMeta;
    version: number;
    content: string;
    assets: { name: string; type: string; bytes: Buffer }[];
};

export type DesignBundleReader = (
    conversation: ConversationId,
    artifact: string,
    version?: number,
) => Promise<DesignBundle>;

/** Validate untrusted identifiers before calling the integration-supplied reader. */
export async function loadBundle(
    readBundle: DesignBundleReader,
    conversation: ConversationId,
    id: string,
    version?: number,
): Promise<DesignBundle> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
        throw new Error("Use the artifact's kebab-case id.");
    }

    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) {
        throw new Error("Version must be a positive integer.");
    }

    const bundle = await readBundle(conversation, id, version);

    if (bundle.meta.type !== "html") {
        throw new Error("Design tools require an HTML artifact.");
    }

    if (!Number.isSafeInteger(bundle.version) || bundle.version < 1) {
        throw new Error("The bundle reader returned an invalid version.");
    }

    return bundle;
}
