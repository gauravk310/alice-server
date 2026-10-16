import { schema, t, type SchemaType } from "@colyseus/schema";

export const Player = schema({
  sessionId: t.string().default(""),
  userId: t.string().default(""),
  name: t.string().default("Player"),
  email: t.string().default(""),
  picture: t.string().default(""),
  isVerified: t.boolean().default(false),
  isHost: t.boolean().default(false),
  isReady: t.boolean().default(false),
  joinedAt: t.number().default(0),
  // Taraju Game Fields
  points: t.number().default(10),
  isSubmitted: t.boolean().default(false),
  isEliminated: t.boolean().default(false),
  currentGuess: t.number().default(-1),
  lastRoundWon: t.boolean().default(false),
});
export type Player = SchemaType<typeof Player>;

export const MyRoomState = schema({
  roomName: t.string().default("Alice Multiplayer Arena"),
  roomCode: t.string().default(""),
  hostSessionId: t.string().default(""),
  status: t.string().default("waiting"), // "waiting" | "countdown" | "playing" | "results" | "victory"
  maxPlayers: t.number().default(6),
  players: t.map(Player),
  // Taraju Round Fields
  roundNumber: t.number().default(1),
  roundTimer: t.number().default(180),
  countdownTimer: t.number().default(10),
  targetScore: t.number().default(0),
  averageScore: t.number().default(0),
});
export type MyRoomState = SchemaType<typeof MyRoomState>;
