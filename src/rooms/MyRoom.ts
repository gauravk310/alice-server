import { Room, Client, ServerError } from "colyseus";
import { MyRoomState, Player } from "./schema/MyRoomState.js";
import {
  verifyGoogleToken,
  type GoogleAuthPayload,
} from "../services/googleAuth.js";
import { verifySessionToken } from "../services/sessionAuth.js";
import { activeRoomsMap } from "./roomRegistry.js";

function generateRoomCode(): string {
  const num = Math.floor(1000 + Math.random() * 9000);
  return "TRJ-" + num;
}

export class MyRoom extends Room<{ state: MyRoomState }> {
  maxClients = 6;
  roomCode = "";
  hostUserId = "";

  getPlayersRoster() {
    return Array.from(this.state.players.values()).map((p) => ({
      sessionId: p.sessionId,
      userId: p.userId,
      name: p.name,
      picture: p.picture,
      isHost: Boolean(p.isHost),
      isReady: Boolean(p.isReady),
      joinedAt: p.joinedAt,
    }));
  }

  broadcastRoster() {
    const players = this.getPlayersRoster();
    this.broadcast("room_roster", {
      players,
      totalPlayers: players.length,
      maxPlayers: this.state.maxPlayers,
      roomCode: this.roomCode,
      roomName: this.state.roomName,
    });
  }

  onCreate(options: any) {
    const maxPlayers = Math.min(Math.max(Number(options?.maxPlayers) || 6, 2), 16);
    this.maxClients = maxPlayers;

    const roomName = (options?.roomName && typeof options.roomName === "string" && options.roomName.trim())
      ? options.roomName.trim()
      : "Taraju Arena";

    this.roomCode = options?.roomCode || generateRoomCode();

    const state = new MyRoomState();
    state.roomName = roomName;
    state.roomCode = this.roomCode;
    state.maxPlayers = maxPlayers;
    state.status = "waiting";

    this.setState(state);

    // Initial registration in activeRoomsMap
    activeRoomsMap.set(this.roomId, {
      roomId: this.roomId,
      roomCode: this.roomCode,
      roomName: roomName,
      hostName: options?.hostName || "Host",
      hostAvatar: options?.hostAvatar || "",
      hostUserId: "",
      playerCount: 0,
      maxPlayers: maxPlayers,
      status: "waiting",
      createdAt: Date.now(),
    });

    this.onMessage("get_roster", (client: Client) => {
      client.send("room_roster", {
        players: this.getPlayersRoster(),
        totalPlayers: this.state.players.size,
        maxPlayers: this.state.maxPlayers,
        roomCode: this.roomCode,
        roomName: this.state.roomName,
      });
    });

    this.onMessage("ping", (client: Client, message: any) => {
      const player = this.state.players.get(client.sessionId);
      const name = player ? player.name : "Player";
      client.send("pong", {
        message: "Pong! Hello " + name + ", backend connection successful!",
        timestamp: Date.now(),
      });
    });

    this.onMessage("start_game", (client: Client, message: any) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !player.isHost) {
        client.send("error", { message: "Only the host can start the game!" });
        return;
      }

      this.state.status = "starting";
      const roomSummary = activeRoomsMap.get(this.roomId);
      if (roomSummary) {
        roomSummary.status = "in_progress";
      }

      this.broadcast("game_started", {
        message: "Game started by " + player.name + "!",
        startedBy: player.name,
        timestamp: Date.now(),
      });

      // After 3 seconds countdown transition to playing
      this.clock.setTimeout(() => {
        this.state.status = "playing";
        this.broadcast("game_active", {
          message: "Arena battle is live!",
        });
      }, 3000);
    });

    this.onMessage("toggle_ready", (client: Client) => {
      const player = this.state.players.get(client.sessionId);
      if (player) {
        player.isReady = !player.isReady;
        this.broadcastRoster();
      }
    });

    this.onMessage("chat", (client: Client, message: any) => {
      const player = this.state.players.get(client.sessionId);
      if (player && message?.text) {
        this.broadcast("chat_message", {
          id: "msg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
          sessionId: client.sessionId,
          senderName: player.name,
          avatar: player.picture,
          isHost: player.isHost,
          text: String(message.text).slice(0, 200),
          timestamp: Date.now(),
        });
      }
    });

    this.onMessage("kick_player", (client: Client, message: any) => {
      const host = this.state.players.get(client.sessionId);
      if (!host || !host.isHost) return;

      const targetSessionId = message?.targetSessionId;
      if (!targetSessionId || targetSessionId === client.sessionId) return;

      const targetClient = this.clients.find(c => c.sessionId === targetSessionId);
      if (targetClient) {
        targetClient.send("kicked", { message: "You were removed by the host." });
        targetClient.leave(4002);
      }
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
        role: sessionUser.role || "player",
        isVerified: true,
        dbId: sessionUser.id,
      };
    }

    // 2. Fallback: Verify raw Google ID token (in-memory without DB write)
    const googlePayload = await verifyGoogleToken(token);
    if (googlePayload && googlePayload.isVerified) {
      return {
        ...googlePayload,
        role: "player",
        dbId: googlePayload.googleId,
      };
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

    // Determine host: First client or creator
    const isFirstPlayer = this.state.players.size === 0;
    if (isFirstPlayer || options?.isHost) {
      player.isHost = true;
      player.isReady = true;
      this.state.hostSessionId = client.sessionId;
      this.hostUserId = player.userId;
    } else {
      player.isHost = false;
      player.isReady = false;
    }

    this.state.players.set(client.sessionId, player);

    // Update activeRoomsMap
    const roomSummary = activeRoomsMap.get(this.roomId);
    if (roomSummary) {
      roomSummary.playerCount = this.state.players.size;
      if (player.isHost) {
        roomSummary.hostName = player.name;
        roomSummary.hostAvatar = player.picture;
        roomSummary.hostUserId = player.userId;
      }
    }

    console.log(
      "Player joined: " + player.name + " (" + player.email + ") [sessionId: " + client.sessionId + ", isHost: " + player.isHost + "]"
    );

    client.send("welcome", {
      message: "Welcome to Alice Arena, " + player.name + "!",
      sessionId: client.sessionId,
      isHost: player.isHost,
      roomCode: this.roomCode,
      roomName: this.state.roomName,
      maxPlayers: this.state.maxPlayers,
      players: this.getPlayersRoster(),
      user: {
        id: player.userId,
        name: player.name,
        email: player.email,
        picture: player.picture,
        isVerified: player.isVerified,
      },
    });

    // Broadcast updated authoritative roster to all connected players immediately!
    this.broadcastRoster();
  }

  onLeave(client: Client, code?: number) {
    const player = this.state.players.get(client.sessionId);
    if (player) {
      console.log(
        "Player left: " + player.name + " [sessionId: " + client.sessionId + "]"
      );
      this.state.players.delete(client.sessionId);

      // If host leaves, assign next player as host
      if (player.isHost && this.state.players.size > 0) {
        const remainingPlayers = Array.from(this.state.players.values());
        const nextPlayer = remainingPlayers[0];
        if (nextPlayer) {
          nextPlayer.isHost = true;
          this.state.hostSessionId = nextPlayer.sessionId;
          this.hostUserId = nextPlayer.userId;

          const roomSummary = activeRoomsMap.get(this.roomId);
          if (roomSummary) {
            roomSummary.hostName = nextPlayer.name;
            roomSummary.hostAvatar = nextPlayer.picture;
            roomSummary.hostUserId = nextPlayer.userId;
          }

          this.broadcast("host_changed", {
            newHostSessionId: nextPlayer.sessionId,
            newHostName: nextPlayer.name,
          });
        }
      }

      // Update active rooms registry
      const roomSummary = activeRoomsMap.get(this.roomId);
      if (roomSummary) {
        roomSummary.playerCount = this.state.players.size;
      }

      // Broadcast updated roster to all remaining clients
      this.broadcastRoster();
    }
  }

  onDispose() {
    activeRoomsMap.delete(this.roomId);
    console.log("Room disposed: " + this.roomId);
  }
}
