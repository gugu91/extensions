import { describe, expect, it } from "vitest";
import type { Broker } from "./broker/index.js";
import type { BrokerDB } from "./broker/schema.js";
import { createBrokerRuntimeAccess } from "./broker-runtime-access.js";

describe("createBrokerRuntimeAccess", () => {
  it("reads the active broker, broker db, self id, and Home tab viewers from the runtime getters", () => {
    const db = { label: "db-1" } as unknown as BrokerDB;
    const broker = { db } as unknown as Broker;
    let activeBroker: Broker | null = broker;
    let selfId: string | null = "broker-1";
    let homeTabViewerIds = ["U123", "U456"];
    const access = createBrokerRuntimeAccess({
      getBroker: () => activeBroker,
      getSelfId: () => selfId,
      getHomeTabViewerIds: () => homeTabViewerIds,
    });

    expect(access.getActiveBroker()).toBe(broker);
    expect(access.getActiveBrokerDb()).toBe(db);
    expect(access.getActiveBrokerSelfId()).toBe("broker-1");
    expect(access.getBrokerControlPlaneHomeTabViewerIds()).toEqual(["U123", "U456"]);

    activeBroker = null;
    selfId = null;
    homeTabViewerIds = ["U789"];

    expect(access.getActiveBroker()).toBeNull();
    expect(access.getActiveBrokerDb()).toBeNull();
    expect(access.getActiveBrokerSelfId()).toBeNull();
    expect(access.getBrokerControlPlaneHomeTabViewerIds()).toEqual(["U789"]);
  });

  it("returns null for the broker db when the active broker is missing", () => {
    const access = createBrokerRuntimeAccess({
      getBroker: () => null,
      getSelfId: () => "broker-2",
      getHomeTabViewerIds: () => [],
    });

    expect(access.getActiveBrokerDb()).toBeNull();
    expect(access.getActiveBrokerSelfId()).toBe("broker-2");
  });
});
