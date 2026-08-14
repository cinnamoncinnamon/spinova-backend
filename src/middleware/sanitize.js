// Server-side mirror of rx8's src/utils/sanitize.js mobile/password rules.
// The frontend doing this too is a UX nicety; this copy is the one that
// actually matters, because a request can always skip the frontend entirely.

export function sanitize(val) {
  if (typeof val !== "string") return "";
  return val
    .replace(/<[^>]*>/g, "")
    .replace(/['"`;\\]/g, "")
    .replace(/--/g, "")
    .replace(/\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|EXEC|SCRIPT)\b/gi, "")
    .trim();
}

// Accepts 01XXXXXXXXX (11 digits) or +8801XXXXXXXXX, normalizes to +880...
export function validateMobile(val) {
  const cleaned = val.replace(/\s/g, "");
  if (/^\+8801[3-9]\d{8}$/.test(cleaned)) return { ok: true, value: cleaned };
  if (/^01[3-9]\d{8}$/.test(cleaned)) return { ok: true, value: "+880" + cleaned };
  return { ok: false, message: "Enter a valid BD mobile number (e.g. 01XXXXXXXXX)" };
}

export function validatePassword(val) {
  if (typeof val !== "string") return { ok: false, message: "Password is required." };
  if (val.length < 6) return { ok: false, message: "Password must be at least 6 characters." };
  if (val.length > 64) return { ok: false, message: "Password too long." };
  if (val !== val.trim()) return { ok: false, message: "Password cannot start or end with spaces." };
  return { ok: true };
}

export function validateRegisterInput({ mobile, password, confirmPassword, name }) {
  const cleanMobile = sanitize(mobile || "");
  const cleanName = sanitize(name || "");

  if (!cleanMobile || !password || !confirmPassword) {
    return { ok: false, message: "Fill all fields." };
  }

  const mobileCheck = validateMobile(cleanMobile);
  if (!mobileCheck.ok) return mobileCheck;

  const passCheck = validatePassword(password);
  if (!passCheck.ok) return passCheck;

  if (password !== confirmPassword) {
    return { ok: false, message: "Passwords don't match." };
  }

  if (cleanName.length > 100) {
    return { ok: false, message: "Name too long." };
  }

  return { ok: true, mobile: mobileCheck.value, name: cleanName };
}

export function validateLoginInput({ mobile, password }) {
  const cleanMobile = sanitize(mobile || "");

  if (!cleanMobile || !password) {
    return { ok: false, message: "Please fill all fields." };
  }

  const mobileCheck = validateMobile(cleanMobile);
  if (!mobileCheck.ok) return mobileCheck;

  return { ok: true, mobile: mobileCheck.value };
}

// Accepts the recovery code as shown to the user: XXXX-XXXX-XXXX
// (uppercase letters/digits, dashes optional on input).
export function validateRecoveryCode(val) {
  if (typeof val !== "string") return { ok: false, message: "Recovery code is required." };
  const cleaned = val.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length !== 12) return { ok: false, message: "Enter your 12-character recovery code." };
  return { ok: true, value: cleaned };
}

export function validateForgotPasswordInput({ mobile, recoveryCode, newPassword, confirmNewPassword }) {
  const cleanMobile = sanitize(mobile || "");

  if (!cleanMobile || !recoveryCode || !newPassword || !confirmNewPassword) {
    return { ok: false, message: "Fill all fields." };
  }

  const mobileCheck = validateMobile(cleanMobile);
  if (!mobileCheck.ok) return mobileCheck;

  const codeCheck = validateRecoveryCode(recoveryCode);
  if (!codeCheck.ok) return codeCheck;

  const passCheck = validatePassword(newPassword);
  if (!passCheck.ok) return passCheck;

  if (newPassword !== confirmNewPassword) {
    return { ok: false, message: "Passwords don't match." };
  }

  return { ok: true, mobile: mobileCheck.value, recoveryCode: codeCheck.value };
}
