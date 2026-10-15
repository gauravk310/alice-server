import { OAuth2Client } from "google-auth-library";
import mongoose from "mongoose";
import { User, type IUser } from "../models/User.js";

const googleClientId = (process.env.GOOGLE_CLIENT_ID || "").trim();
const oauthClient = googleClientId ? new OAuth2Client(googleClientId) : new OAuth2Client();

export interface GoogleAuthPayload {
  googleId: string;
  email: string;
  name: string;
  avatar: string;
  isVerified: boolean;
}

/**
 * Verify a Google ID token received from the client.
 */
export async function verifyGoogleToken(token: string): Promise<GoogleAuthPayload | null> {
  if (!token || typeof token !== "string" || token.startsWith("mock-") || token.startsWith("guest-")) {
    return null;
  }

  // Official verification via Google OAuth2 Client
  if (googleClientId) {
    try {
      const ticket = await oauthClient.verifyIdToken({
        idToken: token,
        audience: googleClientId,
      });
      const payload = ticket.getPayload();

      if (!payload || !payload.email) {
        console.warn("⚠️ [GoogleAuth] Token payload missing email");
        return null;
      }

      return {
        googleId: payload.sub,
        email: payload.email.toLowerCase(),
        name: payload.name || payload.email.split("@")[0],
        avatar: payload.picture || "",
        isVerified: payload.email_verified || false,
      };
    } catch (err: any) {
      console.warn("⚠️ [GoogleAuth] Token verification failed:", err?.message || err);
      return null;
    }
  }

  // Fallback: If GOOGLE_CLIENT_ID is not configured, decode JWT payload
  try {
    const parts = token.split(".");
    if (parts.length === 3) {
      const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const jsonPayload = Buffer.from(base64, "base64").toString("utf-8");
      const decoded = JSON.parse(jsonPayload);

      if (decoded.email && decoded.sub) {
        return {
          googleId: decoded.sub,
          email: decoded.email.toLowerCase(),
          name: decoded.name || decoded.email.split("@")[0],
          avatar: decoded.picture || "",
          isVerified: Boolean(decoded.email_verified),
        };
      }
    }
  } catch (decodeErr) {
    console.warn("⚠️ [GoogleAuth] Failed to decode token:", decodeErr);
  }

  return null;
}

/**
 * Find or create a user in MongoDB Atlas ONLY from verified Google accounts.
 * Guest and mock users are NEVER saved to the database.
 */
export async function syncGoogleUserWithDatabase(
  profile: GoogleAuthPayload
): Promise<IUser | { _id: string; email: string; name: string; avatar: string; role: string; lastLoginAt: Date }> {
  // Strictly allow only verified Google accounts
  if (
    !profile ||
    !profile.googleId ||
    !profile.email ||
    profile.googleId.startsWith("guest-") ||
    profile.googleId.startsWith("mock-") ||
    profile.email.includes("@guest.local") ||
    !profile.isVerified
  ) {
    throw new Error("Unauthorized: Only verified Google accounts can be synced.");
  }

  // Check if MongoDB is currently connected
  if (mongoose.connection.readyState !== 1) {
    console.warn("⚠️ [GoogleAuth] MongoDB not connected (readyState !== 1). Returning transient profile.");
    return {
      _id: profile.googleId,
      email: profile.email,
      name: profile.name,
      avatar: profile.avatar,
      role: "player",
      lastLoginAt: new Date(),
    };
  }

  try {
    // Find existing user by googleId or email
    let user = await User.findOne({
      $or: [{ googleId: profile.googleId }, { email: profile.email }],
    });

    if (user) {
      // Update existing record
      user.googleId = profile.googleId;
      if (profile.name) user.name = profile.name;
      if (profile.avatar) user.avatar = profile.avatar;
      user.lastLoginAt = new Date();
      await user.save();
      console.log(`👤 [GoogleAuth] Updated existing user in MongoDB: ${user.email} (${user._id})`);
      return user;
    } else {
      // Create new user record
      user = await User.create({
        googleId: profile.googleId,
        email: profile.email,
        name: profile.name,
        avatar: profile.avatar,
        role: "player",
        lastLoginAt: new Date(),
      });
      console.log(`✨ [GoogleAuth] Created new user in MongoDB: ${user.email} (${user._id})`);
      return user;
    }
  } catch (error) {
    console.error("❌ [GoogleAuth] Error saving user to MongoDB:", error);
    throw error;
  }
}
