import { startAgyBridgeClient } from "./server.js";

const client = startAgyBridgeClient();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    client.stop();
    process.exit(0);
  });
}
