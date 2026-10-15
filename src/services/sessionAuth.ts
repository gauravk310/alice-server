import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.SESSION_SECRET ||
  "alice-arena-secure-jwt-session-secret-key-32chars";

// Default session expiration: 7 days
export const DEFAULT_SESSION_EXPIRATION_SECONDS = 7 * 24 * 60 * 60;

export interface SessionUser {
  id: string;
  googleId: string;
  email: string;
  name: string;
  avatar?: string;
  role?: string;
  isVerified: boolean;
}

export interface SessionPayload extends SessionUser {
  iat: number;
  exp: number;
}

function base64UrlEncode(data: string | Buffer): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return buf.toString("base64url");
}

function base64UrlDecode(str: string): string {
  return Buffer.from(str, "base64url").toString("utf8");
}

/**
 * Create a signed HMAC-SHA256 App Session Token (JWT).
 * Valid for 7 days by default.
 */
export function createSessionToken(
  user: SessionUser,
  expiresInSeconds: number = DEFAULT_SESSION_EXPIRATION_SECONDS
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload: SessionPayload = {
    ...user,
    iat: now,
    exp: now + expiresInSeconds,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  const hmac = crypto.createHmac("sha256", JWT_SECRET);
  hmac.update(signatureInput);
  const encodedSignature = base64UrlEncode(hmac.digest());

  return `${signatureInput}.${encodedSignature}`;
}

/**
 * Verify an App Session Token. Returns payload if valid and unexpired, null otherwise.
 */
export function verifySessionToken(token: string): SessionPayload | null {
  if (!token || typeof token !== "string") return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  try {
    const signatureInput = `${encodedHeader}.${encodedPayload}`;
    const hmac = crypto.createHmac("sha256", JWT_SECRET);
    hmac.update(signatureInput);
    const expectedSignature = base64UrlEncode(hmac.digest());

    const sigBuf = Buffer.from(encodedSignature);
    const expectedBuf = Buffer.from(expectedSignature);

    if (
      sigBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(sigBuf, expectedBuf)
    ) {
      return null;
    }

    const payload: SessionPayload = JSON.parse(base64UrlDecode(encodedPayload));
    const now = Math.floor(Date.now() / 1000);

    if (payload.exp && now > payload.exp) {
      console.warn(
        `⚠️ [SessionAuth] Session token expired at ${new Date(
          payload.exp * 1000
        ).toISOString()}`
      );
      return null;
    }

    return payload;
  } catch (err) {
    return null;
  }
}

export interface AuthenticatedRequest extends Request {
  user?: SessionPayload;
}

/**
 * Express middleware to authenticate requests via JWT Session Token.
 * Accepts token in Authorization header (`Bearer <token>`), body (`token` or `sessionToken`), or query parameter.
 */
export function authenticateSession(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  const token =
    req.body?.sessionToken ||
    req.body?.token ||
    (typeof req.query?.token === "string" ? req.query.token : null) ||
    (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null);

  if (!token) {
    return res.status(401).json({
      success: false,
      error: "Authentication required: No session token provided",
    });
  }

  const user = verifySessionToken(token);
  if (!user) {
    return res.status(401).json({
      success: false,
      error: "Invalid or expired session token. Please sign in again.",
    });
  }

  (req as any).user = user;
  next();
}
