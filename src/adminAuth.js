const { createHmac, randomBytes, timingSafeEqual } = require("crypto");
const { config } = require("./config");

const SESSION_COOKIE_NAME = "hardware_builder_admin";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();

function encode(value) {
  return Buffer.from(String(value || ""), "utf8");
}

function secureEqual(left, right) {
  const leftBuffer = encode(left);
  const rightBuffer = encode(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function createSignature(sessionId) {
  return createHmac("sha256", config.adminSessionSecret)
    .update(sessionId)
    .digest("hex");
}

function parseCookieHeader(cookieHeader) {
  return String(cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((accumulator, part) => {
      const separatorIndex = part.indexOf("=");

      if (separatorIndex === -1) {
        return accumulator;
      }

      const key = decodeURIComponent(part.slice(0, separatorIndex).trim());
      const value = decodeURIComponent(part.slice(separatorIndex + 1).trim());
      accumulator[key] = value;
      return accumulator;
    }, {});
}

function cleanupExpiredSessions() {
  const now = Date.now();

  for (const [sessionId, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(sessionId);
    }
  }
}

function buildSessionCookie(value, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`
  ];

  return parts.join("; ");
}

function createAdminSession() {
  cleanupExpiredSessions();

  const sessionId = randomBytes(24).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;

  sessions.set(sessionId, {
    username: config.adminUsername,
    expiresAt
  });

  return {
    sessionId,
    expiresAt,
    cookie: buildSessionCookie(
      `${sessionId}.${createSignature(sessionId)}`,
      Math.floor(SESSION_TTL_MS / 1000)
    )
  };
}

function clearAdminSession(req) {
  const session = getAdminSession(req);

  if (session) {
    sessions.delete(session.sessionId);
  }

  return buildSessionCookie("", 0);
}

function getAdminSession(req) {
  cleanupExpiredSessions();

  const cookies = parseCookieHeader(req.headers.cookie);
  const rawValue = cookies[SESSION_COOKIE_NAME];

  if (!rawValue) {
    return null;
  }

  const [sessionId, signature] = rawValue.split(".");

  if (!sessionId || !signature) {
    return null;
  }

  const expectedSignature = createSignature(sessionId);

  if (!secureEqual(signature, expectedSignature)) {
    sessions.delete(sessionId);
    return null;
  }

  const session = sessions.get(sessionId);

  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS;

  return {
    sessionId,
    username: session.username,
    expiresAt: session.expiresAt
  };
}

function isValidAdminCredentials(username, password) {
  return (
    secureEqual(String(username || ""), config.adminUsername) &&
    secureEqual(String(password || ""), config.adminPassword)
  );
}

module.exports = {
  clearAdminSession,
  createAdminSession,
  getAdminSession,
  isValidAdminCredentials
};
