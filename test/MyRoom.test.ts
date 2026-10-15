import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { MyRoomState } from "../src/rooms/schema/MyRoomState.js";

function createMockJwt(payload: Record<string, any>) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("testing your Colyseus app", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => (colyseus = await boot(appConfig)));
  after(async () => colyseus.shutdown());

  beforeEach(async () => {
    await colyseus.cleanup();
  });

  it("rejects unauthenticated anonymous connections", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    await assert.rejects(async () => {
      await colyseus.connectTo(room);
    }, /Authentication required/);
  });

  it("allows verified authenticated users to join via Google token", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const token = createMockJwt({
      sub: "1234567890",
      email: "player@example.com",
      name: "Verified Player",
      picture: "https://example.com/avatar.png",
      email_verified: true,
    });

    const client = await colyseus.connectTo(room, { token });
    assert.strictEqual(client.sessionId, room.clients[0].sessionId);

    const player = room.state.players.get(client.sessionId);
    assert.ok(player);
    assert.strictEqual(player.email, "player@example.com");
    assert.strictEqual(player.isVerified, true);
  });

  it("allows players to join with App Session Token (7-day token)", async () => {
    const { createSessionToken } = await import("../src/services/sessionAuth.js");
    const sessionToken = createSessionToken({
      id: "user-mongo-id-123",
      googleId: "google-sub-456",
      email: "sessionplayer@example.com",
      name: "Session Player",
      avatar: "https://example.com/avatar.jpg",
      isVerified: true,
    });

    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const client = await colyseus.connectTo(room, { token: sessionToken });
    assert.strictEqual(client.sessionId, room.clients[0].sessionId);

    const player = room.state.players.get(client.sessionId);
    assert.ok(player);
    assert.strictEqual(player.name, "Session Player");
    assert.strictEqual(player.email, "sessionplayer@example.com");
    assert.strictEqual(player.userId, "user-mongo-id-123");
  });

  it("rejects expired App Session Tokens", async () => {
    const { createSessionToken } = await import("../src/services/sessionAuth.js");
    // Create an expired session token (-10 seconds)
    const expiredToken = createSessionToken(
      {
        id: "user-mongo-id-123",
        googleId: "google-sub-456",
        email: "expired@example.com",
        name: "Expired Player",
        isVerified: true,
      },
      -10
    );

    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    await assert.rejects(async () => {
      await colyseus.connectTo(room, { token: expiredToken });
    }, /Authentication failed/);
  });
});
