import { schema, t, type SchemaType } from "@colyseus/schema";

export const Player = schema({
  sessionId: t.string().default(""),
  userId: t.string().default(""),
  name: t.string().default("Player"),
  email: t.string().default(""),
  picture: t.string().default(""),
  isVerified: t.boolean().default(false),
  joinedAt: t.number().default(0),
});
export type Player = SchemaType<typeof Player>;

export const MyRoomState = schema({
  roomName: t.string().default("Alice Multiplayer Arena"),
  players: t.map(Player),
});
export type MyRoomState = SchemaType<typeof MyRoomState>;
