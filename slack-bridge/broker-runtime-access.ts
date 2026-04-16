import type { Broker } from "./broker/index.js";
import type { BrokerDB } from "./broker/schema.js";

export interface BrokerRuntimeAccessDeps {
  getBroker: () => Broker | null;
  getSelfId: () => string | null;
  getHomeTabViewerIds: () => string[];
}

export interface BrokerRuntimeAccess {
  getActiveBroker: () => Broker | null;
  getActiveBrokerDb: () => BrokerDB | null;
  getActiveBrokerSelfId: () => string | null;
  getBrokerControlPlaneHomeTabViewerIds: () => string[];
}

export function createBrokerRuntimeAccess(deps: BrokerRuntimeAccessDeps): BrokerRuntimeAccess {
  function getActiveBroker(): Broker | null {
    return deps.getBroker();
  }

  function getActiveBrokerDb(): BrokerDB | null {
    return (getActiveBroker()?.db as BrokerDB | undefined) ?? null;
  }

  function getActiveBrokerSelfId(): string | null {
    return deps.getSelfId();
  }

  function getBrokerControlPlaneHomeTabViewerIds(): string[] {
    return deps.getHomeTabViewerIds();
  }

  return {
    getActiveBroker,
    getActiveBrokerDb,
    getActiveBrokerSelfId,
    getBrokerControlPlaneHomeTabViewerIds,
  };
}
