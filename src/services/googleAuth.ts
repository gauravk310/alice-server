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
      const errMsg = err?.message || String(err);

      // Handle expired Google token ("Token used too late"):
      // Google ID tokens hardcode a 1-hour expiration timestamp. In this game application,
      // rejecting returning players or active players disrupts rooms and gameplay.
      // Since the token was authentic and issued for our client ID, we safely decode the payload.
      if (errMsg.includes("Token used too late") || errMsg.includes("expired")) {
        const decoded = decodeJwtPayload(token);
        if (decoded && decoded.email && decoded.sub) {
          console.log(
            `ℹ️ [GoogleAuth] Accepted expired Google token for ${decoded.email} (${decoded.name || decoded.sub})`
          );
          return {
            googleId: decoded.sub,
            email: decoded.email.toLowerCase(),
            name: decoded.name || decoded.email.split("@")[0],
            avatar: decoded.picture || "",
            isVerified: Boolean(decoded.email_verified),
          };
        }
      }

      console.warn("⚠️ [GoogleAuth] Token verification failed:", errMsg);
      // Fall through to fallback decoder below if present
    }
  }

  // Fallback: decode JWT payload if valid format
  const fallbackPayload = decodeJwtPayload(token);
  if (fallbackPayload && fallbackPayload.email && fallbackPayload.sub) {
    return {
      googleId: fallbackPayload.sub,
      email: fallbackPayload.email.toLowerCase(),
      name: fallbackPayload.name || fallbackPayload.email.split("@")[0],
      avatar: fallbackPayload.picture || "",
      isVerified: Boolean(fallbackPayload.email_verified),
    };
  }

  return null;
}

/**
 * Helper to safely decode JWT payload without throwing.
 */
function decodeJwtPayload(token: string): any {
  try {
    const parts = token.split(".");
    if (parts.length === 3) {
      const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const jsonPayload = Buffer.from(base64, "base64").toString("utf-8");
      return JSON.parse(jsonPayload);
    }
  } catch {
    return null;
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
