import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BrokerDB } from "./broker/schema.js";
import { persistDeliveredInboundMessage } from "./broker-inbound-persistence.js";

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createDb(): { db: BrokerDB; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-bridge-inbound-persist-"));
  const db = new BrokerDB(path.join(dir, "broker.db"));
  db.initialize();
  return { db, dir };
}

describe("persistDeliveredInboundMessage", () => {
  it("stores broker-handled Slack messages as delivered but unread", () => {
    const { db, dir } = createDb();
    cleanupDirs.push(dir);

    try {
      db.createThread("123.456", "slack", "C123", "broker-1");
      const message = {
        source: "slack",
        threadId: "123.456",
        channel: "C123",
        userId: "U1",
        userName: "User One",
        text: "hello broker",
        timestamp: "123.456",
        metadata: { channel: "C123", timestamp: "123.456" },
      };

      const persisted = persistDeliveredInboundMessage(db, "broker-1", message);

      expect(persisted.freshDelivery).toBe(true);
      expect(db.getInbox("broker-1")).toHaveLength(0);
      const liveSync = db.getInboxForLiveSync("broker-1");
      expect(liveSync).toHaveLength(1);
      const read = db.readInbox("broker-1", { markRead: false });
      expect(read.unreadCountBefore).toBe(1);
      expect(read.messages).toHaveLength(1);
      expect(read.messages[0]?.entry).toMatchObject({
        messageId: persisted.message.id,
        delivered: true,
        readAt: null,
        liveDeliveredAt: null,
      });
      expect(read.messages[0]?.message).toMatchObject({
        externalId: "C123:123.456",
        externalTs: "123.456",
        body: "hello broker",
      });
    } finally {
      db.close();
    }
  });

  it("suppresses broker live sync after a fresh delivery is surfaced", () => {
    const { db, dir } = createDb();
    cleanupDirs.push(dir);

    try {
      db.createThread("123.456", "slack", "C123", "broker-1");
      const message = {
        source: "slack",
        threadId: "123.456",
        channel: "C123",
        userId: "U1",
        userName: "User One",
        text: "hello broker",
        timestamp: "123.456",
        metadata: { channel: "C123", timestamp: "123.456" },
      };

      const persisted = persistDeliveredInboundMessage(db, "broker-1", message);
      expect(db.getInboxForLiveSync("broker-1")).toHaveLength(1);

      db.markLiveDeliveredByMessageId(persisted.message.id, "broker-1");

      expect(db.getInboxForLiveSync("broker-1")).toHaveLength(0);
      const read = db.readInbox("broker-1", { markRead: false });
      expect(read.unreadCountBefore).toBe(1);
      expect(read.messages).toHaveLength(1);
      expect(read.messages[0]?.entry.liveDeliveredAt).toEqual(expect.any(String));
    } finally {
      db.close();
    }
  });

  it("does not create duplicate unread rows for Slack replays", () => {
    const { db, dir } = createDb();
    cleanupDirs.push(dir);

    try {
      db.createThread("123.456", "slack", "C123", "broker-1");
      const message = {
        source: "slack",
        threadId: "123.456",
        channel: "C123",
        userId: "U1",
        userName: "User One",
        text: "hello broker",
        timestamp: "123.456",
        metadata: { channel: "C123", timestamp: "123.456" },
      };

      const first = persistDeliveredInboundMessage(db, "broker-1", message);
      const replay = persistDeliveredInboundMessage(db, "broker-1", {
        ...message,
        text: "hello broker replay",
      });

      const read = db.readInbox("broker-1", { markRead: false });
      expect(first.freshDelivery).toBe(true);
      expect(replay.freshDelivery).toBe(false);
      expect(replay.message.id).toBe(first.message.id);
      expect(read.unreadCountBefore).toBe(1);
      expect(read.messages).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
