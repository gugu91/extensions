import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import { operationIdToSdkExportName } from "../cli-helpers.ts";

type HttpMethod = "delete" | "get" | "patch" | "post" | "put";

type OpenApiParameter = {
  in?: string;
  name?: string;
};

type OpenApiOperation = {
  operationId?: string;
  parameters?: OpenApiParameter[];
};

type OpenApiPathItem = Partial<Record<HttpMethod, OpenApiOperation>>;

type OpenApiSpec = {
  paths?: Record<string, OpenApiPathItem>;
};

type SpecSource = {
  label: string;
  url: string;
};

type DownloadedSpec = {
  source: SpecSource;
  raw: string;
  spec: OpenApiSpec;
  extension: ".json" | ".yml";
};

type ParameterLocation = "body" | "headers" | "path" | "query";

type SlackOperation = {
  slackMethod: string;
  operationId: string;
  parameterLocations: Record<string, ParameterLocation>;
};

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED_DIR = join(PACKAGE_ROOT, "generated");
const TEMP_ROOT = join(PACKAGE_ROOT, ".tmp");

const SPEC_SOURCES: ReadonlyArray<SpecSource> = [
  {
    label: "official Slack spec",
    url: "https://raw.githubusercontent.com/slackapi/slack-api-specs/master/web-api/slack_web_openapi_v2.json",
  },
  {
    label: "community Slack spec",
    url: "https://raw.githubusercontent.com/api-evangelist/slack/main/openapi/slack-web-api-openapi.yml",
  },
];

async function run(command: string, args: ReadonlyArray<string>, cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function downloadSpec(tempDir: string): Promise<DownloadedSpec> {
  const errors: string[] = [];

  for (const source of SPEC_SOURCES) {
    try {
      const downloadPath = join(tempDir, source.url.endsWith(".json") ? "spec.json" : "spec.yml");
      await run(
        "curl",
        ["-L", "--fail", "--silent", "--show-error", source.url, "-o", downloadPath],
        PACKAGE_ROOT,
      );

      const raw = await readFile(downloadPath, "utf8");
      const trimmed = raw.trim();
      const extension = trimmed.startsWith("{") ? ".json" : ".yml";
      const spec =
        extension === ".json" ? (JSON.parse(raw) as OpenApiSpec) : (YAML.parse(raw) as OpenApiSpec);

      if (!spec.paths || typeof spec.paths !== "object") {
        throw new Error("spec did not contain a paths object");
      }

      return {
        source,
        raw,
        spec,
        extension,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${source.label}: ${message}`);
    }
  }

  throw new Error(`Unable to download Slack OpenAPI spec. ${errors.join(" | ")}`);
}

function mapParameterLocation(location: string | undefined): ParameterLocation | undefined {
  if (location === "body" || location === "formData") {
    return "body";
  }
  if (location === "header") {
    return "headers";
  }
  if (location === "path") {
    return "path";
  }
  if (location === "query") {
    return "query";
  }
  return undefined;
}

function collectSlackOperations(spec: OpenApiSpec): SlackOperation[] {
  const operations: SlackOperation[] = [];

  for (const [pathName, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const httpMethod of ["delete", "get", "patch", "post", "put"] as const) {
      const operation = pathItem[httpMethod];
      if (!operation?.operationId || !pathName.startsWith("/")) {
        continue;
      }

      const parameterLocations: Record<string, ParameterLocation> = {};
      for (const parameter of operation.parameters ?? []) {
        const location = mapParameterLocation(parameter.in);
        if (location && parameter.name) {
          parameterLocations[parameter.name] = location;
        }
      }

      operations.push({
        slackMethod: pathName.slice(1),
        operationId: operation.operationId,
        parameterLocations,
      });
    }
  }

  return operations.sort((left, right) => left.slackMethod.localeCompare(right.slackMethod));
}

function collectSdkMethodExports(source: string): Map<string, string> {
  const methodExports = new Map<string, string>();
  const pattern = /export const (\w+)\s*=.*?url:\s*'\/([^']+)'/gs;

  for (const match of source.matchAll(pattern)) {
    methodExports.set(match[2], match[1]);
  }

  return methodExports;
}

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        return listTypeScriptFiles(fullPath);
      }
      return fullPath.endsWith(".ts") ? [fullPath] : [];
    }),
  );

  return files.flat();
}

async function rewriteGeneratedImportsToTypeScript(directory: string): Promise<void> {
  const files = await listTypeScriptFiles(directory);
  await Promise.all(
    files.map(async (filePath) => {
      const source = await readFile(filePath, "utf8");
      const updated = source.replaceAll(/(["'])((?:\.\.\/|\.\/)[^"']+)\.js\1/g, "$1$2.ts$1");
      if (updated !== source) {
        await writeFile(filePath, updated, "utf8");
      }
    }),
  );
}

function buildMethodIndexFile(
  operations: ReadonlyArray<SlackOperation>,
  sdkMethodExports: ReadonlyMap<string, string>,
): string {
  const sdkExportEntries = new Map<string, string>();
  const canonicalMethodEntries = new Map<string, string>();
  const parameterLocationEntries: Record<string, Record<string, ParameterLocation>> = {};
  const canonicalMethodNames = operations.map((operation) => operation.slackMethod);

  for (const operation of operations) {
    const predictedExport = operationIdToSdkExportName(operation.operationId);
    const resolvedExport = sdkMethodExports.get(operation.slackMethod) ?? predictedExport;

    parameterLocationEntries[operation.slackMethod] = operation.parameterLocations;

    for (const alias of [operation.slackMethod, operation.operationId, resolvedExport]) {
      sdkExportEntries.set(alias, resolvedExport);
      canonicalMethodEntries.set(alias, operation.slackMethod);
    }
  }

  const methodsLiteral = JSON.stringify(canonicalMethodNames, null, 2);
  const sdkExportsLiteral = JSON.stringify(Object.fromEntries(sdkExportEntries), null, 2);
  const canonicalMethodsLiteral = JSON.stringify(
    Object.fromEntries(canonicalMethodEntries),
    null,
    2,
  );
  const parameterLocationsLiteral = JSON.stringify(parameterLocationEntries, null, 2);

  return `// Generated by scripts/generate.ts. Do not edit manually.\n\nexport const slackMethodNames = ${methodsLiteral} as const;\n\nexport const methodNameToSdkExport = ${sdkExportsLiteral} as const;\n\nexport const methodNameToCanonicalMethod = ${canonicalMethodsLiteral} as const;\n\nexport const methodNameToParameterLocations = ${parameterLocationsLiteral} as const;\n\nexport type SlackMethodName = (typeof slackMethodNames)[number];\nexport type SlackApiInvocationName = keyof typeof methodNameToSdkExport;\n`;
}

async function main(): Promise<void> {
  await mkdir(TEMP_ROOT, { recursive: true });
  const tempDir = await mkdtemp(join(TEMP_ROOT, "slack-api-"));

  try {
    const downloadedSpec = await downloadSpec(tempDir);
    const specPath = join(tempDir, `slack-web-api${downloadedSpec.extension}`);
    await writeFile(specPath, downloadedSpec.raw, "utf8");

    await rm(GENERATED_DIR, { recursive: true, force: true });
    await run("pnpm", ["exec", "openapi-ts", "-i", specPath, "-o", GENERATED_DIR], PACKAGE_ROOT);
    await rewriteGeneratedImportsToTypeScript(GENERATED_DIR);

    const sdkSource = await readFile(join(GENERATED_DIR, "sdk.gen.ts"), "utf8");
    const sdkMethodExports = collectSdkMethodExports(sdkSource);
    const operations = collectSlackOperations(downloadedSpec.spec);
    const methodIndexSource = buildMethodIndexFile(operations, sdkMethodExports);
    await writeFile(join(GENERATED_DIR, "methods.gen.ts"), methodIndexSource, "utf8");

    console.log(
      `Generated ${operations.length} Slack Web API methods from ${downloadedSpec.source.label}: ${downloadedSpec.source.url}`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
