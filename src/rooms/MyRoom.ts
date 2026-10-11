import { Room, Client } from "colyseus";
import { MyRoomState, Player } from "./schema/MyRoomState.js";
import {
  verifyGoogleToken,
  syncGoogleUserWithDatabase,
  type GoogleAuthPayload,
} from "../services/googleAuth.js";

export class MyRoom extends Room<{ state: MyRoomState }> {
  maxClients = 50;

  onCreate(options: any) {
    this.setState(new MyRoomState());

    this.onMessage("ping", (client: Client, message: any) => {
      const player = this.state.players.get(client.sessionId);
      const name = player ? player.name : "Player";
      client.send("pong", {
        message: `Pong! Hello ${name}, backend connection successful!`,
        timestamp: Date.now(),
      });
    });
  }

  async onAuth(
    client: Client,
    options: any,
    request?: any
  ): Promise<any> {
    const { token } = options || {};

    let authPayload: GoogleAuthPayload | null = null;

    if (token) {
      authPayload = await verifyGoogleToken(token);
    }

    if (!authPayload) {
      // Unauthenticated / transient fallback - never saved in DB
      return {
        googleId: "transient-" + client.sessionId,
        email: "",
        name: "Anonymous",
        avatar: "",
        isVerified: false,
        dbId: "transient-" + client.sessionId,
      };
    }

    // Only verified Google accounts are synced with MongoDB Atlas
    try {
      const dbUser = await syncGoogleUserWithDatabase(authPayload);
      return {
        ...authPayload,
        dbId: (dbUser as any)._id?.toString() || authPayload.googleId,
      };
    } catch (err) {
      console.warn(
        "⚠️ [MyRoom] Error syncing user with MongoDB, proceeding in-memory:",
        err
      );
      return authPayload;
    }
  }

  onJoin(client: Client, options: any, auth: any) {
    const player = new Player();
    player.sessionId = client.sessionId;
    player.userId = auth?.dbId || auth?.googleId || client.sessionId;
    player.name = auth?.name || "Player";
    player.email = auth?.email || "";
    player.picture = auth?.avatar || "";
    player.isVerified = Boolean(auth?.isVerified);
    player.joinedAt = Date.now();

    this.state.players.set(client.sessionId, player);

    console.log(
      `🎮 Player joined: ${player.name} (${player.email || "Unverified"}) [sessionId: ${client.sessionId}]`
    );

    client.send("welcome", {
      message: `Welcome to Alice Arena, ${player.name}!`,
      sessionId: client.sessionId,
      user: {
        id: player.userId,
        name: player.name,
        email: player.email,
        picture: player.picture,
        isVerified: player.isVerified,
      },
    });
  }

  onLeave(client: Client, code?: number) {
    const player = this.state.players.get(client.sessionId);
    if (player) {
      console.log(
        `👋 Player left: ${player.name} [sessionId: ${client.sessionId}, code: ${code}]`
      );
      this.state.players.delete(client.sessionId);
    }
  }
}