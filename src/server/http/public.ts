/**
 * `/pub/:token` and its bundle assets: an artifact published with no sign-in. The token is the whole of the access;
 * what it shows is a version pinned when it was published, or the artifact's newest (`share.ts`).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PocketApp } from "../app.ts";
import { publicArtifactBundle } from "./artifact-assets.ts";

export async function publicArtifact(
    app: PocketApp,
    request: IncomingMessage,
    response: ServerResponse,
    token: string | undefined,
    query = new URLSearchParams(),
    name = "",
): Promise<void> {
    await publicArtifactBundle(app, request, response, token, name, query);
}
