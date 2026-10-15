import { Room, Client, ServerError } from "colyseus";
import { MyRoomState, Player } from "./schema/MyRoomState.js";
import {
  verifyGoogleToken,
  syncGoogleUserWithDatabase,
  type GoogleAuthPayload,
} from "../services/googleAuth.js";
import { verifySessionToken } from "../services/sessionAuth.js";

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

    if (!token) {
      throw new ServerError(
        401,
        "Authentication required: Please sign in to join the game."
      );
    }

    // 1. Primary: Verify App Session Token (7-day validity)
    const sessionUser = verifySessionToken(token);
    if (sessionUser && sessionUser.isVerified) {
      return {
        googleId: sessionUser.googleId,
        email: sessionUser.email,
        name: sessionUser.name,
        avatar: sessionUser.avatar || "",
        isVerified: true,
        dbId: sessionUser.id,
      };
    }

    // 2. Fallback: Verify raw Google ID token (if client passed Google credential directly)
    const googlePayload = await verifyGoogleToken(token);
    if (googlePayload && googlePayload.isVerified) {
      try {
        const dbUser = await syncGoogleUserWithDatabase(googlePayload);
        return {
          ...googlePayload,
          dbId: (dbUser as any)._id?.toString() || googlePayload.googleId,
        };
      } catch (err) {
        console.warn(
          "⚠️ [MyRoom] Error syncing user with MongoDB, proceeding in-memory:",
          err
        );
        return googlePayload;
      }
    }

    throw new ServerError(
      401,
      "Authentication failed: Invalid or expired session token. Please sign in again."
    );
  }

  onJoin(client: Client, options: any, auth: any) {
    if (!auth || !auth.isVerified) {
      client.leave(4001);
      return;
    }

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
      `🎮 Player joined: ${player.name} (${player.email}) [sessionId: ${client.sessionId}]`
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
    if (player && player.isVerified) {
      console.log(
        `👋 Player left: ${player.name} (${player.email}) [sessionId: ${client.sessionId}, code: ${code}]`
      );
      this.state.players.delete(client.sessionId);
    }
  }
}