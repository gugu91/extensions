import type { RuntimeScopeCarrier } from "@gugu910/pi-transport-core";
import {
  resolveSlackInstallForScope,
  resolveSlackTopology,
  type ResolvedSlackInstallTopology,
  type ResolvedSlackTopology,
  type SlackBridgeSettings,
} from "./helpers.js";
import { resolveSlackChannelId, type SlackCall } from "./slack-access.js";
import { TtlCache } from "./ttl-cache.js";

export interface SlackTopologyRuntimeDeps {
  slack: SlackCall;
  getSettings: () => SlackBridgeSettings;
  env?: NodeJS.ProcessEnv;
}

export interface SlackTopologyRuntime {
  getTopology: () => ResolvedSlackTopology;
  getDefaultInstall: () => ResolvedSlackInstallTopology;
  getDefaultInstallId: () => string;
  getInstall: (installId?: string | null) => ResolvedSlackInstallTopology | null;
  getRuntimeInstalls: () => ResolvedSlackInstallTopology[];
  getSurfaceInstalls: () => ResolvedSlackInstallTopology[];
  resolveInstallForScope: (
    scope: RuntimeScopeCarrier | null | undefined,
  ) => ResolvedSlackInstallTopology | null;
  getBotToken: (installId?: string | null) => string | undefined;
  getAppToken: (installId?: string | null) => string | undefined;
  getDefaultChannel: (installId?: string | null) => string | null;
  getLogChannel: (installId?: string | null) => string | null;
  isHomeTabEnabled: (installId?: string | null) => boolean;
  resolveChannel: (
    installId: string | null | undefined,
    nameOrId: string,
  ) => Promise<string | null>;
}

function normalizeOptionalSetting(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function orderInstalls(
  installs: ResolvedSlackInstallTopology[],
  defaultInstallId: string,
): ResolvedSlackInstallTopology[] {
  return [...installs].sort((left, right) => {
    const leftIsDefault = left.installId === defaultInstallId ? 0 : 1;
    const rightIsDefault = right.installId === defaultInstallId ? 0 : 1;
    return leftIsDefault - rightIsDefault;
  });
}

export function createSlackTopologyRuntime(deps: SlackTopologyRuntimeDeps): SlackTopologyRuntime {
  const env = deps.env ?? process.env;
  const channelCaches = new Map<string, TtlCache<string, string>>();

  function getTopology(): ResolvedSlackTopology {
    return resolveSlackTopology(deps.getSettings(), env);
  }

  function getDefaultInstall(): ResolvedSlackInstallTopology {
    return getTopology().defaultInstall;
  }

  function getDefaultInstallId(): string {
    return getTopology().defaultInstallId;
  }

  function getInstall(installId?: string | null): ResolvedSlackInstallTopology | null {
    const topology = getTopology();
    const normalizedInstallId = normalizeOptionalSetting(installId);
    if (!normalizedInstallId) {
      return topology.defaultInstall;
    }
    return topology.installs.find((install) => install.installId === normalizedInstallId) ?? null;
  }

  function getRuntimeInstalls(): ResolvedSlackInstallTopology[] {
    const topology = getTopology();
    return orderInstalls(
      topology.installs.filter(
        (
          install,
        ): install is ResolvedSlackInstallTopology & {
          botToken: string;
          appToken: string;
        } => typeof install.botToken === "string" && typeof install.appToken === "string",
      ),
      topology.defaultInstallId,
    );
  }

  function getSurfaceInstalls(): ResolvedSlackInstallTopology[] {
    const topology = getTopology();
    return orderInstalls(
      topology.installs.filter(
        (
          install,
        ): install is ResolvedSlackInstallTopology & {
          botToken: string;
        } => typeof install.botToken === "string",
      ),
      topology.defaultInstallId,
    );
  }

  function resolveInstallForScope(
    scope: RuntimeScopeCarrier | null | undefined,
  ): ResolvedSlackInstallTopology | null {
    return resolveSlackInstallForScope(getTopology(), scope);
  }

  function getBotToken(installId?: string | null): string | undefined {
    return getInstall(installId)?.botToken;
  }

  function getAppToken(installId?: string | null): string | undefined {
    return getInstall(installId)?.appToken;
  }

  function getDefaultChannel(installId?: string | null): string | null {
    return normalizeOptionalSetting(getInstall(installId)?.defaultChannel);
  }

  function getLogChannel(installId?: string | null): string | null {
    return normalizeOptionalSetting(getInstall(installId)?.logChannel);
  }

  function isHomeTabEnabled(installId?: string | null): boolean {
    return getInstall(installId)?.homeTabEnabled ?? false;
  }

  async function resolveChannel(
    installId: string | null | undefined,
    nameOrId: string,
  ): Promise<string | null> {
    const install = getInstall(installId);
    const token = install?.botToken;
    const normalizedNameOrId = normalizeOptionalSetting(nameOrId);
    if (!install || !token || !normalizedNameOrId) {
      return null;
    }

    let cache = channelCaches.get(install.installId);
    if (!cache) {
      cache = new TtlCache<string, string>({ maxSize: 200, ttlMs: 30 * 60 * 1000 });
      channelCaches.set(install.installId, cache);
    }

    return resolveSlackChannelId({
      slack: deps.slack,
      token,
      nameOrId: normalizedNameOrId,
      cache,
    });
  }

  return {
    getTopology,
    getDefaultInstall,
    getDefaultInstallId,
    getInstall,
    getRuntimeInstalls,
    getSurfaceInstalls,
    resolveInstallForScope,
    getBotToken,
    getAppToken,
    getDefaultChannel,
    getLogChannel,
    isHomeTabEnabled,
    resolveChannel,
  };
}
