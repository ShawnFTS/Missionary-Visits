// Input rules for the two things a family types.

export function cleanFamily(raw) {
  let s = String(raw ?? "").replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>]/g, "").replace(/\s+/g, " ").trim();
  // Families type "Smith" and "Smith Family" both; show it one way.
  s = s.replace(/\s*\bfamily\b\s*$/i, "").trim();
  if (!s || s.length > 50) return null;
  return s;
}

// US numbers only (it is a local stake). Returns +1XXXXXXXXXX or null.
export function normalizePhone(raw) {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === "1") return `+${d}`;
  return null;
}

export const maskPhone = (e164) => `(•••) •••-${e164.slice(-4)}`;
export const displayFamily = (f) => `${f} Family`;

export function cleanAddress(raw) {
  const s = String(raw ?? "").replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>]/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, 200) : null;
}

export const fmtPhone = (e164) => `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;
