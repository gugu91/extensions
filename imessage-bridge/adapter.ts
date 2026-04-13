import type {
  InboundMessage as IMessageAdapterInboundMessage,
  MessageAdapter,
  OutboundMessage as IMessageAdapterOutboundMessage,
} from "@gugu910/pi-transport-core";
import {
  assertIMessageSendCapability,
  sendIMessage,
  type RunAppleScript,
} from "./send.js";
import type { DetectIMessageMvpEnvironmentOptions, IMessageMvpEnvironment } from "./mvp.js";

export type { IMessageAdapterInboundMessage, IMessageAdapterOutboundMessage };

export interface IMessageAdapterOptions {
  osascriptPath?: string;
  runAppleScript?: RunAppleScript;
  detectEnvironmentOptions?: DetectIMessageMvpEnvironmentOptions;
  detectEnvironment?: (
    options?: DetectIMessageMvpEnvironmentOptions,
  ) => IMessageMvpEnvironment;
}

export interface IMessageAdapter extends MessageAdapter {
  readonly name: "imessage";
}

export class AppleScriptIMessageAdapter implements IMessageAdapter {
  readonly name = "imessage" as const;

  private readonly options: IMessageAdapterOptions;
  private inboundHandler: ((msg: IMessageAdapterInboundMessage) => void) | null = null;

  constructor(options: IMessageAdapterOptions = {}) {
    this.options = options;
  }

  async connect(): Promise<void> {
    const detectEnvironment = this.options.detectEnvironment;
    const environment = detectEnvironment
      ? detectEnvironment(this.options.detectEnvironmentOptions)
      : null;

    if (environment) {
      if (!environment.canAttemptSend) {
        throw new Error(
          [
            "iMessage send-first adapter is not ready.",
            `platform: ${environment.platform}`,
            `osascript: ${environment.osascriptAvailable ? "ready" : "missing"} (${environment.osascriptPath})`,
            `messages-db: ${environment.messagesDbAvailable ? "ready" : "missing"} (${environment.messagesDbPath})`,
            `mvp blockers: ${environment.blockers.join(", ")}`,
          ].join(" "),
        );
      }
      return;
    }

    assertIMessageSendCapability(this.options.detectEnvironmentOptions);
  }

  async disconnect(): Promise<void> {
    this.inboundHandler = null;
  }

  onInbound(handler: (msg: IMessageAdapterInboundMessage) => void): void {
    this.inboundHandler = handler;
  }

  async send(msg: IMessageAdapterOutboundMessage): Promise<void> {
    await sendIMessage({
      recipient: msg.channel,
      text: msg.text,
      osascriptPath: this.options.osascriptPath,
      runAppleScript: this.options.runAppleScript,
    });
  }
}

export function createIMessageAdapter(options: IMessageAdapterOptions = {}): IMessageAdapter {
  return new AppleScriptIMessageAdapter(options);
}
