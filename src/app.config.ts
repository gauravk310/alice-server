import {
  defineServer,
  defineRoom,
  monitor,
  playground,
  createRouter,
  createEndpoint,
} from "colyseus";
import express from "express";
import mongoose from "mongoose";

/**
 * Import your Room files
 */
import { MyRoom } from "./rooms/MyRoom.js";
import {
  verifyGoogleToken,
  syncGoogleUserWithDatabase,
} from "./services/googleAuth.js";
import { User } from "./models/User.js";

const server = defineServer({
  /**
   * Define your room handlers:
   */
  rooms: {
    my_room: defineRoom(MyRoom),
  },

  /**
   * Experimental: Define API routes. Built-in integration with the "playground" and SDK.
   */
  routes: createRouter({
    api_hello: createEndpoint("/api/hello", { method: "GET" }, async (ctx) => {
      return { message: "Hello World" };
    }),
  }),

  /**
   * Bind your custom express routes here:
   */
  express: (app) => {
    // Parse JSON request bodies
    app.use(express.json());

    // Basic test endpoint
    app.get("/hi", (req, res) => {
      res.send("It's time to kick ass and chew bubblegum!");
    });

    /**
     * POST /api/auth/google
     * Verify Google ID token from frontend and save/sync user into MongoDB
     */
    app.post("/api/auth/google", async (req, res) => {
      try {
        const token = req.body?.credential || req.body?.token;
        if (!token) {
          return res.status(400).json({
            success: false,
            error: "Missing Google ID token or credential in request body",
          });
        }

        const authPayload = await verifyGoogleToken(token);
        if (!authPayload || !authPayload.isVerified) {
          return res.status(401).json({
            success: false,
            error: "Invalid, expired, or unverified Google token",
          });
        }

        const user = await syncGoogleUserWithDatabase(authPayload);
        return res.json({
          success: true,
          message: "Google authentication successful",
          user: {
            id: (user as any)._id?.toString() || authPayload.googleId,
            googleId: authPayload.googleId,
            email: user.email,
            name: user.name,
            avatar: user.avatar,
            role: user.role,
            lastLoginAt: user.lastLoginAt,
            isVerified: authPayload.isVerified,
          },
        });
      } catch (err: any) {
        console.error("❌ [/api/auth/google] Authentication error:", err);
        return res.status(500).json({
          success: false,
          error: "Internal server error during authentication",
          details: err?.message,
        });
      }
    });

    /**
     * GET /api/auth/users
     * Retrieve registered players (recent 50)
     */
    app.get("/api/auth/users", async (req, res) => {
      try {
        if (mongoose.connection.readyState !== 1) {
          return res.status(503).json({
            error: "Database is not connected",
          });
        }
        const users = await User.find({})
          .sort({ lastLoginAt: -1 })
          .limit(50)
          .select("-__v");
        return res.json({ users });
      } catch (err: any) {
        return res.status(500).json({ error: err?.message });
      }
    });

    /**
     * System health and status endpoint
     */
    app.get("/api/health", (req, res) => {
      const stateMap: Record<number, string> = {
        0: "disconnected",
        1: "connected",
        2: "connecting",
        3: "disconnecting",
      };
      res.json({
        status: "ok",
        googleAuth: {
          configured: Boolean(process.env.GOOGLE_CLIENT_ID),
        },
        database: {
          status: stateMap[mongoose.connection.readyState] || "unknown",
          readyState: mongoose.connection.readyState,
        },
        timestamp: new Date().toISOString(),
      });
    });

    /**
     * Use @colyseus/monitor
     */
    if (process.env.NODE_ENV !== "production") {
      app.use("/monitor", monitor());
    }

    /**
     * Use @colyseus/playground
     */
    if (process.env.NODE_ENV !== "production") {
      app.use("/", playground());
    }
  },
});

export default server;
