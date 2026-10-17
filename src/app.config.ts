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
import { activeRoomsMap } from "./rooms/roomRegistry.js";
import {
  verifyGoogleToken,
  syncGoogleUserWithDatabase,
} from "./services/googleAuth.js";
import {
  createSessionToken,
  verifySessionToken,
  verifySessionTokenForRefresh,
  authenticateSession,
} from "./services/sessionAuth.js";
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
     * GET /api/rooms
     * Return list of active open rooms
     */
    app.get("/api/rooms", (req, res) => {
      const rooms = Array.from(activeRoomsMap.values());
      return res.json({
        success: true,
        count: rooms.length,
        rooms,
      });
    });

    /**
     * GET /api/rooms/:codeOrId
     * Search room by roomCode or roomId
     */
    app.get("/api/rooms/:codeOrId", (req, res) => {
      const param = String(req.params.codeOrId).trim().toUpperCase();
      const rooms = Array.from(activeRoomsMap.values());
      const found = rooms.find(
        (r) => r.roomId === req.params.codeOrId || r.roomCode.toUpperCase() === param
      );
      if (!found) {
        return res.status(404).json({ success: false, error: "Room not found" });
      }
      return res.json({ success: true, room: found });
    });

    /**
     * POST /api/auth/google
     * Verify Google ID token from frontend, sync with MongoDB, and issue a 7-day App Session Token
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
        const userId = (user as any)._id?.toString() || authPayload.googleId;

        // Create 7-day App Session Token (JWT)
        const sessionToken = createSessionToken({
          id: userId,
          googleId: authPayload.googleId,
          email: user.email,
          name: user.name,
          avatar: user.avatar,
          role: user.role,
          isVerified: authPayload.isVerified,
        });

        return res.json({
          success: true,
          message: "Google authentication successful",
          sessionToken,
          token: sessionToken,
          user: {
            id: userId,
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
        console.error("Authentication error:", err);
        return res.status(500).json({
          success: false,
          error: "Internal server error during authentication",
          details: err?.message,
        });
      }
    });

    /**
     * POST /api/auth/refresh
     * Refresh an existing App Session Token without requiring Google sign-in again
     */
    app.post("/api/auth/refresh", async (req, res) => {
      try {
        const authHeader = req.headers.authorization;
        const token =
          req.body?.sessionToken ||
          req.body?.token ||
          (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null);

        if (!token) {
          return res.status(400).json({
            success: false,
            error: "Missing session token to refresh",
          });
        }

        const payload = verifySessionTokenForRefresh(token);
        if (!payload) {
          return res.status(401).json({
            success: false,
            error: "Session expired beyond renewal window or invalid. Please sign in again with Google.",
          });
        }

        // Issue new 7-day session token
        const newSessionToken = createSessionToken({
          id: payload.id,
          googleId: payload.googleId,
          email: payload.email,
          name: payload.name,
          avatar: payload.avatar,
          role: payload.role,
          isVerified: payload.isVerified,
        });

        return res.json({
          success: true,
          message: "Session successfully refreshed",
          sessionToken: newSessionToken,
          token: newSessionToken,
          user: {
            id: payload.id,
            googleId: payload.googleId,
            email: payload.email,
            name: payload.name,
            avatar: payload.avatar,
            role: payload.role,
            isVerified: payload.isVerified,
          },
        });
      } catch (err: any) {
        console.error("Refresh error:", err);
        return res.status(500).json({
          success: false,
          error: "Failed to refresh session",
          details: err?.message,
        });
      }
    });

    /**
     * GET /api/auth/me
     * Validate session token and return the current authenticated player profile
     */
    app.get("/api/auth/me", authenticateSession, (req, res) => {
      const user = (req as any).user;
      return res.json({
        success: true,
        user,
      });
    });

    /**
     * GET /api/auth/users
     * Retrieve registered players (recent 50) - Protected by JWT session
     */
    app.get("/api/auth/users", authenticateSession, async (req, res) => {
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
