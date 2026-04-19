export {
  APPLESCRIPT_BINARY_PATH,
  DEFAULT_MESSAGES_DB_RELATIVE_PATH,
  type DetectIMessageMvpEnvironmentOptions,
  detectIMessageMvpEnvironment,
  formatIMessageMvpReadiness,
  getDefaultMessagesDbPath,
  type IMessageMvpEnvironment,
  type IMessageMvpEnvironmentBlocker,
} from "./mvp.js";
export {
  AppleScriptIMessageAdapter,
  createIMessageAdapter,
  type IMessageAdapter,
  type IMessageAdapterInboundMessage,
  type IMessageAdapterOptions,
  type IMessageAdapterOutboundMessage,
} from "./adapter.js";
export {
  assertIMessageSendCapability,
  buildIMessageSendAppleScript,
  getDefaultIMessageThreadId,
  normalizeIMessageRecipient,
  runAppleScript,
  resolveIMessageBody,
  sendIMessage,
  type RunAppleScript,
  type RunAppleScriptInput,
  type RunAppleScriptResult,
  type SendIMessageOptions,
} from "./send.js";
