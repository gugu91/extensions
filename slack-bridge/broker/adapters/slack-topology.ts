import type { RuntimeScopeCarrier } from "@gugu910/pi-transport-core";
import type { ResolvedSlackInstallTopology } from "../../helpers.js";
import type { ParsedAppHomeOpened } from "../../slack-access.js";
import type { InboundMessage, OutboundMessage, MessageAdapter } from "./types.js";
import { SlackAdapter, type SlackAdapterConfig } from "./slack.js";

export interface ScopedAppHomeOpenedEvent extends ParsedAppHomeOpened {
  installId: string;
  scope: RuntimeScopeCarrier;
}

export interface SlackTopologyAdapterConfig {
  installs: ReadonlyArray<ResolvedSlackInstallTopology>;
  defaultInstallId: string;
  resolveInstallForScope: (
    scope: RuntimeScopeCarrier | null | undefined,
  ) => ResolvedSlackInstallTopology | null;
  allowedUsers?: SlackAdapterConfig["allowedUsers"];
  allowAllWorkspaceUsers?: SlackAdapterConfig["allowAllWorkspaceUsers"];
  suggestedPrompts?: SlackAdapterConfig["suggestedPrompts"];
  reactionCommands?: SlackAdapterConfig["reactionCommands"];
  isKnownThread?: SlackAdapterConfig["isKnownThread"];
  rememberKnownThread?: SlackAdapterConfig["rememberKnownThread"];
  onAppHomeOpened?: (event: ScopedAppHomeOpenedEvent) => Promise<void> | void;
}

export class SlackTopologyAdapter implements MessageAdapter {
  readonly name = "slack";

  private readonly config: SlackTopologyAdapterConfig;
  private readonly adapters = new Map<string, SlackAdapter>();
  private inboundHandler: ((msg: InboundMessage) => void) | null = null;

  constructor(config: SlackTopologyAdapterConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.config.installs.length === 0) {
      throw new Error("No runtime-capable Slack installs are configured for broker mode.");
    }

    const started: SlackAdapter[] = [];
    try {
      for (const install of this.config.installs) {
        if (!install.botToken || !install.appToken) {
          continue;
        }

        const adapter = new SlackAdapter({
          botToken: install.botToken,
          appToken: install.appToken,
          allowedUsers: this.config.allowedUsers,
          allowAllWorkspaceUsers: this.config.allowAllWorkspaceUsers,
          suggestedPrompts: this.config.suggestedPrompts,
          reactionCommands: this.config.reactionCommands,
          getDefaultScope: () => install.scope,
          isKnownThread: this.config.isKnownThread,
          rememberKnownThread: this.config.rememberKnownThread,
          onAppHomeOpened: async (event) => {
            await this.config.onAppHomeOpened?.({
              ...event,
              installId: install.installId,
              scope: install.scope,
            });
          },
        });
        adapter.onInbound((message) => {
          this.inboundHandler?.(message);
        });
        await adapter.connect();
        this.adapters.set(install.installId, adapter);
        started.push(adapter);
      }
    } catch (error) {
      await Promise.allSettled(started.map((adapter) => adapter.disconnect()));
      this.adapters.clear();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const adapters = [...this.adapters.values()];
    this.adapters.clear();
    await Promise.allSettled(adapters.map((adapter) => adapter.disconnect()));
  }

  onInbound(handler: (msg: InboundMessage) => void): void {
    this.inboundHandler = handler;
  }

  async send(msg: OutboundMessage): Promise<void> {
    const selectedInstall = this.config.resolveInstallForScope(msg.scope ?? null);
    const fallbackInstall =
      this.config.installs.find((install) => install.installId === this.config.defaultInstallId) ??
      this.config.installs[0] ??
      null;
    const install = selectedInstall ?? (msg.scope ? null : fallbackInstall);
    if (!install) {
      throw new Error("No Slack install is authorized for the outbound message scope.");
    }

    const adapter = this.adapters.get(install.installId);
    if (!adapter) {
      throw new Error(`Slack install ${JSON.stringify(install.installId)} is not connected.`);
    }

    await adapter.send({
      ...msg,
      ...(msg.scope ? {} : { scope: install.scope }),
    });
  }

  getBotUserId(): string | null {
    return this.adapters.get(this.config.defaultInstallId)?.getBotUserId() ?? null;
  }

  isConnected(): boolean {
    return [...this.adapters.values()].some((adapter) => adapter.isConnected());
  }
}
