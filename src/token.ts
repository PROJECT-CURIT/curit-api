import { createHash, randomBytes } from "node:crypto"

export function createQrToken() {
  return randomBytes(24).toString("base64url")
}

export function hashQrToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

export function assertQrToken(token: string) {
  if (!/^[A-Za-z0-9_-]{12,128}$/.test(token)) {
    throw new Error("QR token has an invalid format")
  }
  return token
}
