import { describe, expect, it } from "vitest";
import { ActiveResourceTracker } from "@agent-runtime-gateway/core";

describe("ActiveResourceTracker", () => {
  it("tracks response and session pins independently", () => {
    const tracker = new ActiveResourceTracker();
    tracker.pinResponse("resp_1");
    tracker.pinSession("session-a");
    expect(tracker.isResponseActive("resp_1")).toBe(true);
    expect(tracker.isSessionActive("session-a")).toBe(true);
    tracker.unpinResponse("resp_1");
    tracker.unpinSession("session-a");
    expect(tracker.counts()).toEqual({ activeResponses: 0, activeSessions: 0 });
  });
});
