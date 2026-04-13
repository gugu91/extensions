import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@gugu910/pi-imessage-bridge": fileURLToPath(
        new URL("../imessage-bridge/index.ts", import.meta.url),
      ),
      "@gugu910/pi-transport-core": fileURLToPath(
        new URL("../transport-core/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["**/*.test.ts"],
  },
});
