/**
 * The static design scan in a worker thread (`scanProject` starts it): `scanTokens` reads and works synchronously, so in a
 * worker of its own a large or hostile project does not hold up the server, and the worker can be stopped (a time limit,
 * a heap limit). It posts the scan back and ends.
 */
import { parentPort, workerData } from "node:worker_threads";
import { type Rendered, scanTokens } from "./scan.ts";

const { root, rendered } = workerData as { root: string; rendered?: Rendered };

parentPort!.postMessage(scanTokens(root, rendered));
