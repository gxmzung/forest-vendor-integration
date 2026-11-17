import { Worker } from "node:worker_threads";
import { config } from "../config.js";
import { GoogleSheetLogForwarder, type GoogleSheetLogRow } from "./google-sheet.js";

export class DurableCoreLogForwarder {
  private readonly writer: GoogleSheetLogForwarder;
  private worker?: Worker;
  private restartDelay = 1000;
  private lastHeartbeat = Date.now();

  constructor(databasePath: string, endpoint: string, timeout: number) {
    // Persist each log before returning. Only the expensive replay is off-thread.
    this.writer = new GoogleSheetLogForwarder(endpoint, timeout, 2, undefined, databasePath, false);
    const start = () => {
      const worker = new Worker(new URL("./core-log-worker.js", import.meta.url), { execArgv: [], workerData: { databasePath, endpoint, timeout } });
      this.worker = worker;
      this.lastHeartbeat = Date.now();
      worker.on("message", message => {
        this.restartDelay = 1000;
        this.lastHeartbeat = Date.now();
        if (message === "ready") console.info("[core-log-worker] ready");
      });
      worker.on("error", error => console.error("[core-log-worker]", error.message));
      worker.on("exit", () => {
        this.worker = undefined;
        setTimeout(start, this.restartDelay).unref();
        this.restartDelay = Math.min(this.restartDelay * 2, 60000);
      });
      worker.unref();
    };
    start();
    setInterval(() => {
      if (this.worker && Date.now() - this.lastHeartbeat > 30000) void this.worker.terminate();
    }, 5000).unref();
  }

  enqueue(row: GoogleSheetLogRow): void {
    this.writer.enqueue(row);
    this.worker?.postMessage("wake");
  }
}

export const coreDbLogForwarder = process.env.NODE_ENV === "production"
  ? new DurableCoreLogForwarder("/app/data/core-log-queue.sqlite", `${config.coreServerUrl}/internal/v1/vendor-request-logs`, config.coreRequestTimeoutMs)
  : new GoogleSheetLogForwarder(`${config.coreServerUrl}/internal/v1/vendor-request-logs`, config.coreRequestTimeoutMs);
