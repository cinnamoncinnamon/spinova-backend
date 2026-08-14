import jwt from "jsonwebtoken";

// Verifies a real admin session token (issued by POST /api/admin/login),
// instead of trusting a static shared key. The signing secret
// (ADMIN_JWT_SECRET) never leaves the server, so there's nothing for a
// browser to leak.
export function requireAdmin(req, res, next) {
  const header = req.headers.authorization;
  const token = header && header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Admin login required." });
  }

  try {
    const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    if (payload.role !== "admin") throw new Error("Wrong role");
    req.admin = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired admin session." });
  }
}