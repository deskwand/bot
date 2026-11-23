import { describe, expect, it } from "vitest";
import { admittedOnConnection } from "../../src/channels/channel-do";
import { ownerPrincipal } from "../../src/members/principal";

describe("owner message dispatch", () => {
  it("carries the connection ref so admission can check it", () => {
    // Without the ref the Butler compares the message against the deployment
    // route, which can never match a channel key: every message was dropped.
    const admitted = admittedOnConnection(
      {
        eventId: "evt-1",
        channel: "wechat",
        fromUserId: "u1",
        conversationId: "u1",
        text: "你好",
        messageId: "m-1",
        receivedAt: 1,
      } as never,
      "conn-route-key",
      {
        actor: ownerPrincipal(),
        ref: { memberId: "owner", connectionId: "c1", generation: 2 },
      },
    );
    expect(admitted.actor?.memberId).toBe("owner");
    expect(admitted.connectionRef).toEqual({
      memberId: "owner",
      connectionId: "c1",
      generation: 2,
    });
    expect(admitted.routeKey).toBe("conn-route-key");
  });
});
