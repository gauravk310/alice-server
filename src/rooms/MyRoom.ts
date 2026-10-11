import { Room, Client } from "colyseus";

export class MyRoom extends Room {
  onCreate() {
    this.onMessage("ping", (client: Client) => {
      client.send("pong", {
        message: "Backend connection successful!",
        timestamp: Date.now(),
      });
    });
  }

  onJoin(client: Client) {
    client.send("welcome", {
      message: "Successfully joined the multiplayer room",
      sessionId: client.sessionId,
    });
  }
}