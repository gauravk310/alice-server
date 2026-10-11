import dns from "node:dns";
import mongoose from "mongoose";

// Configure public DNS resolvers to handle SRV records reliably on Windows
try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
  dns.setDefaultResultOrder?.("ipv4first");
} catch (e) {
  // Ignore if not supported
}

/**
 * Connect to MongoDB using Mongoose.
 */
export async function connectDatabase(): Promise<typeof mongoose | null> {
  let mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    console.warn(
      "\n⚠️ [Database] MONGODB_URI is not defined in your environment (.env).\n" +
      "⚠️ [Database] Please set MONGODB_URI to connect to MongoDB Atlas.\n"
    );
    return null;
  }

  // Ensure default database name if none provided
  if (mongoUri.endsWith(".mongodb.net/")) {
    mongoUri += "alice?retryWrites=true&w=majority";
  }

  try {
    mongoose.connection.on("connected", () => {
      console.log("✅ Connected to MongoDB successfully.");
    });

    mongoose.connection.on("error", (err) => {
      console.error("❌ MongoDB connection error:", err);
    });

    mongoose.connection.on("disconnected", () => {
      console.warn("⚠️ MongoDB disconnected.");
    });

    const conn = await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
    });
    return conn;
  } catch (error: any) {
    console.error("❌ Failed to connect to MongoDB:", error?.message || error);

    if (error?.code === "ECONNREFUSED" || error?.syscall === "querySrv") {
      console.warn(
        "\n💡 [Atlas SRV DNS Tip]: If querySrv ECONNREFUSED persists on Windows:\n" +
        "   1. Whitelist your IP in MongoDB Atlas: Network Access -> Add IP Address -> 'Allow Access From Anywhere (0.0.0.0/0)'.\n" +
        "   2. Or in Atlas connection modal, choose 'Drivers' -> select an older driver version (e.g. Node.js 2.2.12 or later) to get the standard non-SRV connection string (mongodb://host1:27017,host2:27017...).\n"
      );
    }

    return null;
  }
}

/**
 * Gracefully disconnect from MongoDB.
 */
export async function disconnectDatabase(): Promise<void> {
  try {
    await mongoose.disconnect();
    console.log("🔌 MongoDB disconnected cleanly.");
  } catch (error) {
    console.error("❌ Error disconnecting MongoDB:", error);
  }
}
