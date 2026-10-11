import "./bootstrap.js";
import "dotenv/config";
import { listen } from "@colyseus/tools";

// Import Colyseus config
import app from "./app.config.js";
import { connectDatabase, disconnectDatabase } from "./db/connection.js";

async function start() {
  // Connect to MongoDB
  await connectDatabase();

  // Create and listen on 2567 (or PORT environment variable.)
  listen(app);
}

start().catch((err) => {
  console.error("❌ Error starting server:", err);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  await disconnectDatabase();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await disconnectDatabase();
  process.exit(0);
});
