import { Glob } from "bun";
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../..", import.meta.url));
const output = join(root, "windows", "binaries");
const clientDirectory = join(root, "src", "dist", "client");
await mkdir(output, { recursive: true });
if (!existsSync(join(clientDirectory, "index.html"))) {
  throw new Error("The Vite client bundle is missing. Run `bun run build` in src first.");
}
const clientEntrypoints = Array.from(new Glob("**/*").scanSync(clientDirectory)).map((path) =>
  join(clientDirectory, path),
);
const clientEmbedEntrypoint = join(root, "src", ".windows-client-embed.ts");
const serverEmbedEntrypoint = join(root, "src", ".windows-server-entry.ts");
const clientImports = clientEntrypoints
  .map((path, index) => {
    const relativePath = path
      .slice(join(root, "src").length + 1)
      .replaceAll("\\", "/");
    return `import asset${index} from ${JSON.stringify(`./${relativePath}`)} with { type: "file" };`;
  })
  .join("\n");
const clientAssetNames = clientEntrypoints.map((_path, index) => `asset${index}`).join(", ");
await Bun.write(clientEmbedEntrypoint, `${clientImports}\nexport const windowsClientAssets = [${clientAssetNames}];\n`);
await Bun.write(
  serverEmbedEntrypoint,
  `import { windowsClientAssets } from "./.windows-client-embed.ts";\nvoid windowsClientAssets;\nimport "./server/index.ts";\n`,
);

const targets = [
  ["bun-windows-x64", "x64"],
  ["bun-windows-arm64", "arm64"],
] as const;

try {
  for (const [target, architecture] of targets) {
    const result = await Bun.build({
      entrypoints: [serverEmbedEntrypoint],
      compile: {
        target,
        outfile: `${output}/nocturne-connector-server-${architecture}.exe`,
        windows: {
          hideConsole: true,
          title: "Nocturne Connector Server",
          publisher: "Nocturne",
          version: "2.1.3.0",
          description: "Nocturne Connector background server",
        },
      },
      minify: false,
    });
    if (!result.success) {
      throw new AggregateError(result.logs, `Failed to compile ${target}`);
    }
  }
} finally {
  await rm(clientEmbedEntrypoint, { force: true });
  await rm(serverEmbedEntrypoint, { force: true });
}

await rm(join(output, "client"), { recursive: true, force: true });
await cp(clientDirectory, join(output, "client"), {
  recursive: true,
});
