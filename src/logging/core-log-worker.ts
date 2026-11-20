import { parentPort, workerData } from "node:worker_threads";
import { GoogleSheetLogForwarder } from "./google-sheet.js";

// Replay and retries run away from the HTTP event loop; cap backlog delivery at 80 rows/s.
const queue = new GoogleSheetLogForwarder(workerData.endpoint, workerData.timeout, 2, undefined, workerData.databasePath, true, 25);
parentPort!.on("message", () => queue.wake());
parentPort!.postMessage("ready");
setInterval(() => parentPort!.postMessage("alive"), 5000).unref();
