import { installGlobalProxyDispatcher } from "../../packages/platform/proxy.mjs";

void start().catch((error) => {
  console.error("sunabot failed to start", error);
  process.exitCode = 1;
});

async function start(): Promise<void> {
  await installGlobalProxyDispatcher();
  const { startServer } = await import("./server.js");
  await startServer();
}
