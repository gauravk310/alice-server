export interface ActiveRoomSummary {
  roomId: string;
  roomCode: string;
  roomName: string;
  hostName: string;
  hostAvatar: string;
  hostUserId: string;
  playerCount: number;
  maxPlayers: number;
  status: "waiting" | "in_progress";
  createdAt: number;
}

export const activeRoomsMap = new Map<string, ActiveRoomSummary>();
