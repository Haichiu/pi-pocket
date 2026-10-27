/**
 * /cache-warm on|off|status: the switch for the cache keeper (`src/server/cache-keeper.ts`). It only edits the
 * keeper's file in the data folder; the keeper reads it at every decision. Drop-in: copy into `~/.pi-pocket/extensions/`.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineExtension } from "@earendil-works/pi-durable";
import type { Host, Web } from "./_pocket.d.ts";

export const pocketApi = 2;

export default function createCacheWarm(host: Host, web: Web) {
    const file = join(host.dataDir, "cache-keeper.json");

    const read = (): { enabled?: boolean; gaps?: number[] } => {
        try {
            return JSON.parse(readFileSync(file, "utf8"));
        } catch {
            return {};
        }
    };

    web.command("cache-warm", {
        description: "Keep the prompt cache warm while it costs less than a rebill: on, off, or status",
        args: "[on|off]",
        scope: "conversation",
        handler: (args) => {
            const word = args.trim().toLowerCase();
            const state = read();

            if (word === "on" || word === "off") {
                const temporary = `${file}.tmp`;

                writeFileSync(temporary, JSON.stringify({ ...state, enabled: word === "on" }));
                renameSync(temporary, file);

                return { type: "toast", level: "info", message: `Cache keeper ${word}.` };
            }

            if (word !== "" && word !== "status") {
                throw web.error(400, "Use /cache-warm on, off, or status.");
            }

            return {
                type: "card",
                output: `Cache keeper: ${state.enabled === true ? "on" : "off"} (${state.gaps?.length ?? 0} idle gaps learned)`,
            };
        },
    });

    return defineExtension({ name: "cache-warm" });
}
