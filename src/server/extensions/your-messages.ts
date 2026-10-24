/** Your messages: a list of the people's messages in a session, to find one fast and jump to it, such as a place to fork from. */
// Types only: at run time this module uses nothing of Pi Pocket's but `web`, as a drop-in would.
import type { ExtensionWeb, PocketHost } from "../host.ts";

/** Whether Pi Pocket `version` is 0.20.0 or newer: an older app has no `pocket.messages` or `reveal`. */
function supported(version: string | undefined): boolean {
    const [major = 0, minor = 0] = (version ?? "0.0.0").split(".").map(Number);

    return major > 0 || minor >= 20;
}

export default function createYourMessages(host: PocketHost, web?: ExtensionWeb) {
    if (web === undefined || !supported(host.pocketVersion)) {
        return;
    }

    // Everyone who sees every session: the app checks each page of messages against the person's access.
    web.client("your-messages", { access: "view" });
}
