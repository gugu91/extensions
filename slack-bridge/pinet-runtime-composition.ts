import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Broker } from "./broker/index.js";
import type { MessageRouter } from "./broker/router.js";
import type { InboundMessage, MessageAdapter } from "./broker/types.js";

export interface PinetRuntimeAdapterBinding {
  /** Transport adapter to attach to the broker runtime. */
  adapter: MessageAdapter;
  /** Optional compatibility status used by Slack bridge startup/status surfaces. */
  getBotUserId?: () => string | null;
}

export interface PinetRuntimeAdapterFactoryContext {
  broker: Broker;
  router: MessageRouter;
  selfId: string;
  ctx: ExtensionContext;
}

export type PinetRuntimeAdapterFactory = (
  context: PinetRuntimeAdapterFactoryContext,
) =>
  | PinetRuntimeAdapterBinding
  | PinetRuntimeAdapterBinding[]
  | Promise<PinetRuntimeAdapterBinding | PinetRuntimeAdapterBinding[]>;

export interface ConnectPinetRuntimeAdaptersOptions {
  broker: Pick<Broker, "addAdapter">;
  bindings: PinetRuntimeAdapterBinding[];
  onInbound: (message: InboundMessage) => void;
  signal?: AbortSignal;
}

export interface ConnectPinetRuntimeAdaptersResult {
  botUserId: string | null;
}

function normalizeAdapterBindings(
  value: PinetRuntimeAdapterBinding | PinetRuntimeAdapterBinding[],
): PinetRuntimeAdapterBinding[] {
  return Array.isArray(value) ? value : [value];
}

export async function buildPinetRuntimeAdapterBindings(
  factories: readonly PinetRuntimeAdapterFactory[],
  context: PinetRuntimeAdapterFactoryContext,
): Promise<PinetRuntimeAdapterBinding[]> {
  const bindings: PinetRuntimeAdapterBinding[] = [];

  for (const factory of factories) {
    bindings.push(...normalizeAdapterBindings(await factory(context)));
  }

  return bindings;
}

export async function connectPinetRuntimeAdapters({
  broker,
  bindings,
  onInbound,
  signal,
}: ConnectPinetRuntimeAdaptersOptions): Promise<ConnectPinetRuntimeAdaptersResult> {
  let botUserId: string | null = null;

  for (const binding of bindings) {
    signal?.throwIfAborted();
    binding.adapter.onInbound(onInbound);
    broker.addAdapter(binding.adapter);
    const abortConnect = () => {
      void binding.adapter.disconnect().catch(() => undefined);
    };
    signal?.addEventListener("abort", abortConnect, { once: true });
    try {
      await binding.adapter.connect();
      signal?.throwIfAborted();
      botUserId ??= binding.getBotUserId?.() ?? null;
    } finally {
      signal?.removeEventListener("abort", abortConnect);
    }
  }

  return { botUserId };
}
