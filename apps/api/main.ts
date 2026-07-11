import { startServer } from "./server.js";

void startServer().catch((error) => {
  console.error("sunabot failed to start", error);
  process.exitCode = 1;
});
