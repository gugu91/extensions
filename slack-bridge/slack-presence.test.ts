import { describe, expect, it } from "vitest";
import {
  findSlackPresenceDirectoryUser,
  formatSlackPresenceLine,
  formatSlackPresenceTimestamp,
  getBestSlackPresenceUserName,
  isSlackUserId,
  resolveSlackPresenceDndEndTs,
  stripSlackUserReference,
} from "./slack-presence.js";

describe("stripSlackUserReference", () => {
  it("unwraps Slack mentions and leading @ prefixes", () => {
    expect(stripSlackUserReference("<@U123ABC>")).toBe("U123ABC");
    expect(stripSlackUserReference("@alice")).toBe("alice");
    expect(stripSlackUserReference("  Bob  ")).toBe("Bob");
  });
});

describe("isSlackUserId", () => {
  it("recognizes Slack user IDs and mentions", () => {
    expect(isSlackUserId("U123ABC")).toBe(true);
    expect(isSlackUserId("<@W123ABC>")).toBe(true);
    expect(isSlackUserId("alice")).toBe(false);
  });
});

describe("getBestSlackPresenceUserName", () => {
  it("prefers display name, then real name, then handle", () => {
    expect(
      getBestSlackPresenceUserName({
        id: "U123",
        name: "alice",
        real_name: "Alice Example",
        profile: { display_name: "Alice" },
      }),
    ).toBe("Alice");

    expect(
      getBestSlackPresenceUserName({
        id: "U124",
        name: "bob",
        real_name: "Bob Example",
        profile: { display_name: "" },
      }),
    ).toBe("Bob Example");
    expect(getBestSlackPresenceUserName({ id: "U125", name: "carol" })).toBe("carol");
  });
});

describe("findSlackPresenceDirectoryUser", () => {
  const users = [
    {
      id: "U123",
      name: "alice",
      real_name: "Alice Example",
      profile: { display_name: "Ali" },
    },
    {
      id: "U124",
      name: "bob",
      real_name: "Bob Example",
      profile: { display_name: "Bobby" },
    },
  ];

  it("matches by id, handle, real name, and display name", () => {
    expect(findSlackPresenceDirectoryUser(users, "U123")?.id).toBe("U123");
    expect(findSlackPresenceDirectoryUser(users, "@alice")?.id).toBe("U123");
    expect(findSlackPresenceDirectoryUser(users, "Ali")?.id).toBe("U123");
    expect(findSlackPresenceDirectoryUser(users, "Bob Example")?.id).toBe("U124");
  });

  it("returns null when no user matches", () => {
    expect(findSlackPresenceDirectoryUser(users, "nobody")).toBeNull();
  });
});

describe("resolveSlackPresenceDndEndTs", () => {
  it("prefers snooze end when snooze is active", () => {
    expect(
      resolveSlackPresenceDndEndTs({
        snooze_enabled: true,
        snooze_endtime: 1_800_000_000,
        dnd_enabled: true,
        next_dnd_end_ts: 1_700_000_000,
      }),
    ).toBe(1_800_000_000);
  });

  it("falls back to next_dnd_end_ts for regular DND", () => {
    expect(
      resolveSlackPresenceDndEndTs({
        dnd_enabled: true,
        next_dnd_end_ts: "1700000000",
      }),
    ).toBe(1_700_000_000);
  });

  it("returns undefined when DND is off", () => {
    expect(resolveSlackPresenceDndEndTs({ dnd_enabled: false, snooze_enabled: false })).toBe(
      undefined,
    );
  });
});

describe("formatSlackPresenceTimestamp", () => {
  it("formats positive unix timestamps as ISO strings", () => {
    expect(formatSlackPresenceTimestamp(1_700_000_000)).toBe("2023-11-14T22:13:20.000Z");
    expect(formatSlackPresenceTimestamp(undefined)).toBeUndefined();
  });
});

describe("formatSlackPresenceLine", () => {
  it("formats active and DND-off users", () => {
    expect(
      formatSlackPresenceLine({
        userId: "U123",
        userName: "Alice",
        presence: "active",
        dndEnabled: false,
        online: true,
      }),
    ).toContain("Alice (U123) | presence: active | DND: off | online: yes");
  });

  it("formats DND end times when present", () => {
    expect(
      formatSlackPresenceLine({
        userId: "U124",
        userName: "Bob",
        presence: "away",
        dndEnabled: true,
        dndEndAt: "2026-04-02T14:30:00.000Z",
      }),
    ).toContain("DND: on until 2026-04-02T14:30:00.000Z");
  });
});
