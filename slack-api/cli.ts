import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WebClient } from "@slack/web-api";

import {
  type JsonObject,
  discoverMethods,
  mergeInput,
  parseJsonObject,
  parseKeyValueArg,
  resolveMethod,
} from "./cli-helpers.ts";

const EXECUTABLE_NAME = "slack-api";

function printUsage(): void {
  console.error(`Usage:
  ${EXECUTABLE_NAME} list
  ${EXECUTABLE_NAME} <method> [--token <token>] [--input <json>] [--input-file <path>] [--param KEY=VALUE ...]

Examples:
  ${EXECUTABLE_NAME} auth.test --token xoxb-...
  ${EXECUTABLE_NAME} conversations.list --token xoxb-... --param limit=50
  ${EXECUTABLE_NAME} chat.postMessage --token xoxb-... --input '{"channel":"C123","text":"hello"}'
`);
}

async function main(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    printUsage();
    return;
  }

  if (subcommand === "list") {
    const client = new WebClient();
    for (const method of discoverMethods(client)) {
      console.log(method);
    }
    return;
  }

  let token = process.env.SLACK_TOKEN;
  let inputArg: string | undefined;
  let inputFile: string | undefined;
  const paramArgs: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--token") {
      const value = rest[++index];
      if (value === undefined) throw new Error("Missing value after --token");
      token = value;
      continue;
    }
    if (arg === "--input") {
      const value = rest[++index];
      if (value === undefined) throw new Error("Missing value after --input");
      inputArg = value;
      continue;
    }
    if (arg === "--input-file") {
      const value = rest[++index];
      if (value === undefined) throw new Error("Missing value after --input-file");
      inputFile = value;
      continue;
    }
    if (arg === "--param") {
      const value = rest[++index];
      if (value === undefined) throw new Error("Missing value after --param");
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

  const client = new WebClient(token);
  const method = resolveMethod(client, subcommand);
  if (!method) {
    throw new Error(`Unknown Slack API method: ${subcommand}`);
  }

  const result = await method(input);
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
