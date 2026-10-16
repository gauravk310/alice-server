import { Room, Client, ServerError, Delayed } from "colyseus";
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

  private roundInterval?: Delayed;
  private countdownInterval?: Delayed;
  private nextRoundInterval?: Delayed;

  getPlayersRoster() {
    return Array.from(this.state.players.values()).map((p) => ({
      sessionId: p.sessionId,
      userId: p.userId,
      name: p.name,
      picture: p.picture,
      isHost: Boolean(p.isHost),
      isReady: Boolean(p.isReady),
      joinedAt: p.joinedAt,
      points: p.points,
      isSubmitted: p.isSubmitted,
      isEliminated: p.isEliminated,
      lastRoundWon: p.lastRoundWon,
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
    state.roundNumber = 1;
    state.roundTimer = 180;
    state.countdownTimer = 10;

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

    // 1. Host triggers match start -> 10-second countdown
    this.onMessage("start_game", (client: Client, message: any) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !player.isHost) {
        client.send("error", { message: "Only the host can start the game!" });
        return;
      }

      if (this.state.status === "countdown" || this.state.status === "playing") {
        return;
      }

      this.startMatchCountdown();
    });

    // 2. Player submits secret number choice (0 - 100)
    this.onMessage("submit_guess", (client: Client, message: any) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.isEliminated) return;
      if (this.state.status !== "playing") return;

      const guessNum = Math.max(0, Math.min(100, Math.round(Number(message?.guess) || 50)));
      player.currentGuess = guessNum;
      player.isSubmitted = true;

      // Broadcast that this player locked their choice (without revealing secret guess)
      this.broadcast("player_guess_submitted", {
        sessionId: client.sessionId,
      });

      // Check if all active players have submitted
      const activePlayers = Array.from(this.state.players.values()).filter((p) => !p.isEliminated);
      const allDone = activePlayers.length > 0 && activePlayers.every((p) => p.isSubmitted);

      if (allDone) {
        this.evaluateRound();
      }
    });

    // 3. Skip intermission to next round immediately
    this.onMessage("start_next_round", (client: Client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !player.isHost) return;

      if (this.nextRoundInterval) {
        this.nextRoundInterval.clear();
        this.nextRoundInterval = undefined;
      }
      this.startNextRound();
    });

    // 4. Restart match
    this.onMessage("restart_game", (client: Client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !player.isHost) return;
      this.startMatchCountdown();
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
          text: String(message.text).slice(0, 500),
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

  // Start 10-Second Countdown
  private startMatchCountdown() {
    this.clearAllTimers();

    this.state.status = "countdown";
    this.state.countdownTimer = 10;
    this.state.roundNumber = 1;

    // Reset all players: 10 points allocated!
    this.state.players.forEach((p) => {
      p.points = 10;
      p.isEliminated = false;
      p.isSubmitted = false;
      p.currentGuess = -1;
      p.lastRoundWon = false;
    });

    const roomSummary = activeRoomsMap.get(this.roomId);
    if (roomSummary) {
      roomSummary.status = "in_progress";
    }

    this.broadcast("game_started", {
      countdown: 10,
      players: this.getPlayersRoster(),
      timestamp: Date.now(),
    });

    this.countdownInterval = this.clock.setInterval(() => {
      this.state.countdownTimer -= 1;
      this.broadcast("countdown_tick", {
        count: this.state.countdownTimer,
      });

      if (this.state.countdownTimer <= 0) {
        if (this.countdownInterval) {
          this.countdownInterval.clear();
          this.countdownInterval = undefined;
        }
        this.startRound();
      }
    }, 1000);
  }

  // Start Round with 3-Minute Timer (180 Seconds)
  private startRound() {
    this.clearAllTimers();

    this.state.status = "playing";
    this.state.roundTimer = 180;

    // Reset submissions for active players
    this.state.players.forEach((p) => {
      p.isSubmitted = false;
      p.currentGuess = -1;
      p.lastRoundWon = false;
    });

    this.broadcast("round_started", {
      round: this.state.roundNumber,
      timer: 180,
      players: this.getPlayersRoster(),
    });

    this.roundInterval = this.clock.setInterval(() => {
      this.state.roundTimer -= 1;

      // Every 1s update timer on clients
      if (this.state.roundTimer % 1 === 0) {
        this.broadcast("round_timer_tick", {
          timer: this.state.roundTimer,
        });
      }

      if (this.state.roundTimer <= 0) {
        this.evaluateRound();
      }
    }, 1000);
  }

  // Round Evaluation: 0.7 × Average of submitted guesses
  private evaluateRound() {
    this.clearAllTimers();

    const activePlayers = Array.from(this.state.players.values()).filter((p) => !p.isEliminated);
    if (activePlayers.length === 0) return;

    // Assign default 50 for any active player who did not submit in time
    activePlayers.forEach((p) => {
      if (!p.isSubmitted || p.currentGuess < 0) {
        p.currentGuess = 50;
        p.isSubmitted = true;
      }
    });

    // 1. Calculate Average
    const sum = activePlayers.reduce((acc, p) => acc + p.currentGuess, 0);
    const average = sum / activePlayers.length;

    // 2. Multiply Average by 0.7
    const target = average * 0.7;
    this.state.averageScore = Number(average.toFixed(2));
    this.state.targetScore = Number(target.toFixed(2));

    // 3. Find player(s) closest to target
    let minDiff = Infinity;
    const guessesWithDiff = activePlayers.map((p) => {
      const diff = Math.abs(p.currentGuess - target);
      if (diff < minDiff) minDiff = diff;
      return {
        sessionId: p.sessionId,
        name: p.name,
        guess: p.currentGuess,
        diff,
      };
    });

    const winnerSessionIds: string[] = [];
    guessesWithDiff.forEach((g) => {
      if (Math.abs(g.diff - minDiff) < 0.0001) {
        winnerSessionIds.push(g.sessionId);
      }
    });

    // 4. Update Points:
    // Winners survive and do not lose points.
    // Losers lose 1 point! Reach 0 = eliminated.
    activePlayers.forEach((p) => {
      if (winnerSessionIds.includes(p.sessionId)) {
        p.lastRoundWon = true;
      } else {
        p.lastRoundWon = false;
        p.points -= 1;
        if (p.points <= 0) {
          p.points = 0;
          p.isEliminated = true;
        }
      }
    });

    this.state.status = "results";

    this.broadcast("round_evaluated", {
      round: this.state.roundNumber,
      sum,
      average: this.state.averageScore,
      target: this.state.targetScore,
      winnerSessionIds,
      guesses: guessesWithDiff,
      players: this.getPlayersRoster(),
    });

    // 5. Check survivors
    const survivors = Array.from(this.state.players.values()).filter((p) => p.points > 0);

    if (survivors.length <= 1) {
      this.state.status = "victory";
      const ultimateWinner = survivors[0] || null;
      this.broadcast("game_over", {
        winnerSessionId: ultimateWinner?.sessionId || "",
        winnerName: ultimateWinner?.name || "None",
        roundsPlayed: this.state.roundNumber,
      });
    } else {
      // 8-Second intermission before next round
      let intermission = 8;
      this.broadcast("next_round_countdown", { seconds: intermission });

      this.nextRoundInterval = this.clock.setInterval(() => {
        intermission -= 1;
        this.broadcast("next_round_countdown", { seconds: intermission });

        if (intermission <= 0) {
          if (this.nextRoundInterval) {
            this.nextRoundInterval.clear();
            this.nextRoundInterval = undefined;
          }
          this.startNextRound();
        }
      }, 1000);
    }
  }

  private startNextRound() {
    this.clearAllTimers();
    this.state.roundNumber += 1;
    this.startRound();
  }

  private clearAllTimers() {
    if (this.roundInterval) {
      this.roundInterval.clear();
      this.roundInterval = undefined;
    }
    if (this.countdownInterval) {
      this.countdownInterval.clear();
      this.countdownInterval = undefined;
    }
    if (this.nextRoundInterval) {
      this.nextRoundInterval.clear();
      this.nextRoundInterval = undefined;
    }
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
    player.points = 10;
    player.isSubmitted = false;
    player.isEliminated = false;
    player.currentGuess = -1;
    player.lastRoundWon = false;

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
    this.clearAllTimers();
    activeRoomsMap.delete(this.roomId);
    console.log("Room disposed: " + this.roomId);
  }
}
