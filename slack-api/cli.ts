import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as sdk from "./generated/sdk.gen.ts";
import { client } from "./generated/client.gen.ts";
import {
  methodNameToCanonicalMethod,
  methodNameToParameterLocations,
  methodNameToSdkExport,
  slackMethodNames,
} from "./generated/methods.gen.ts";
import {
  type JsonObject,
  type RequestContainer,
  mergeInput,
  nestMethodInput,
  parseJsonObject,
  parseKeyValueArg,
} from "./cli-helpers.ts";

const DEFAULT_BASE_URL = "https://slack.com/api";
const EXECUTABLE_NAME = "slack-api";

type SdkModule = typeof sdk;
type SdkMethodName = keyof typeof methodNameToSdkExport;
type CanonicalMethodName = keyof typeof methodNameToParameterLocations;
type CallableSdkExport = Extract<
  SdkModule[keyof SdkModule],
  (...args: never[]) => Promise<unknown>
>;

function printUsage(): void {
  console.error(`Usage:
  ${EXECUTABLE_NAME} list
  ${EXECUTABLE_NAME} <method> [--token <token>] [--base-url <url>] [--input <json>] [--input-file <path>] [--param KEY=VALUE ...]

Examples:
  ${EXECUTABLE_NAME} auth.test --token xoxb-...
  ${EXECUTABLE_NAME} conversations.list --token xoxb-... --param limit=50
  ${EXECUTABLE_NAME} chat.postMessage --token xoxb-... --input '{"channel":"C123","text":"hello"}'
`);
}

function resolveMethod(methodName: string): {
  canonicalMethodName: CanonicalMethodName;
  method: CallableSdkExport;
  parameterLocations: Readonly<Record<string, RequestContainer>>;
} {
  const canonicalMethodName =
    methodNameToCanonicalMethod[methodName as keyof typeof methodNameToCanonicalMethod];
  const resolvedExportName = methodNameToSdkExport[methodName as SdkMethodName];
  if (!canonicalMethodName || !resolvedExportName) {
    throw new Error(`Unknown Slack API method: ${methodName}`);
  }

  const candidate = sdk[resolvedExportName as keyof SdkModule];
  if (typeof candidate !== "function") {
    throw new Error(`Generated SDK export is not callable: ${resolvedExportName}`);
  }

  return {
    canonicalMethodName,
    method: candidate as CallableSdkExport,
    parameterLocations: methodNameToParameterLocations[canonicalMethodName],
  };
}

async function main(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    printUsage();
    return;
  }

  if (subcommand === "list") {
    for (const methodName of slackMethodNames) {
      console.log(methodName);
    }
    return;
  }

  let token = process.env.SLACK_TOKEN;
  let baseUrl = DEFAULT_BASE_URL;
  let inputArg: string | undefined;
  let inputFile: string | undefined;
  const paramArgs: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--token") {
      token = rest[++index];
      continue;
    }
    if (arg === "--base-url") {
      baseUrl = rest[++index] ?? baseUrl;
      continue;
    }
    if (arg === "--input") {
      inputArg = rest[++index];
      continue;
    }
    if (arg === "--input-file") {
      inputFile = rest[++index];
      continue;
    }
    if (arg === "--param") {
      const value = rest[++index];
      if (value === undefined) {
        throw new Error("Missing value after --param");
      }
      paramArgs.push(value);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (inputArg && inputFile) {
    throw new Error("Use either --input or --input-file, not both.");
  }

  let input: JsonObject = {};
  if (inputArg) {
    input = parseJsonObject(inputArg);
  } else if (inputFile) {
    input = parseJsonObject(await readFile(inputFile, "utf8"));
  }

  input = mergeInput(input, paramArgs.map(parseKeyValueArg));
  if (token && input.token === undefined) {
    input.token = token;
  }

  const { method, parameterLocations } = resolveMethod(subcommand);
  const requestOptions = nestMethodInput(input, parameterLocations);

  client.setConfig({ baseUrl });

  const result = await method(requestOptions as never);
  console.log(JSON.stringify(result, null, 2));
}

const entrypoint = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (entrypoint) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}

export { main };
