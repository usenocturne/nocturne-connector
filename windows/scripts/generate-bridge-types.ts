import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const windowsRoot = fileURLToPath(new URL("..", import.meta.url));
const rustSchema = await readFile(
  join(windowsRoot, "src-tauri", "src", "bridge.rs"),
  "utf8",
);
const requiredTypes = [
  "BridgeRequest",
  "BridgeResponse",
  "BridgeErrorPayload",
  "BridgeEvent",
];
for (const typeName of requiredTypes) {
  if (!rustSchema.includes(`struct ${typeName}`)) {
    throw new Error(`Rust bridge schema is missing ${typeName}`);
  }
}

const outputPath = join(windowsRoot, "..", "src", "server", "platform", "bridge-types.ts");
const output = `// Generated from windows/src-tauri/src/bridge.rs by windows/scripts/generate-bridge-types.ts.\n\nexport interface HostBridgeRequest {\n  type: "request";\n  id: number;\n  token: string;\n  generation: number;\n  method: string;\n  params: unknown;\n}\n\nexport interface HostBridgeResponse {\n  type: "response";\n  id: number;\n  generation: number;\n  result?: unknown;\n  error?: HostBridgeErrorPayload;\n}\n\nexport interface HostBridgeErrorPayload {\n  code: string;\n  message: string;\n}\n\nexport interface HostBridgeEvent {\n  type: "event";\n  topic: string;\n  data: unknown;\n  generation: number;\n}\n`;
await writeFile(outputPath, output, "utf8");
console.log(`Wrote ${outputPath}`);
