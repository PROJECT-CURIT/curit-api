export type AppConfig = {
  nodeEnv: "development" | "test" | "production"
  trustedProxy?: string
  host: string
  port: number
  webOrigin: string
  publicWebUrl: string
  sessionSecret: string
  paymentMode: "demo" | "toss"
  databaseUrl: string
  tossClientKey: string
  tossSecretKey: string
  tossExpectedMid?: string
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const nodeEnv =
    environment.NODE_ENV === "production"
      ? "production"
      : environment.NODE_ENV === "test"
        ? "test"
        : "development"
  const sessionSecret =
    environment.SESSION_SECRET ||
    (nodeEnv === "production" ? "" : "curit-local-development-secret-change-me")
  if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters")
  }

  const paymentMode = environment.PAYMENT_MODE === "toss" ? "toss" : "demo"
  if (nodeEnv === "production" && paymentMode === "demo") {
    throw new Error("PAYMENT_MODE=demo cannot be used in production")
  }
  const tossClientKey = environment.TOSS_CLIENT_KEY || ""
  const tossSecretKey = environment.TOSS_SECRET_KEY || ""
  const sandboxKeys =
    (/^test_ck_.+/.test(tossClientKey) && /^test_sk_.+/.test(tossSecretKey)) ||
    (/^test_gck_.+/.test(tossClientKey) && /^test_gsk_.+/.test(tossSecretKey))
  if (paymentMode === "toss" && !sandboxKeys) {
    throw new Error(
      "A matching pair of Toss sandbox keys is required when PAYMENT_MODE=toss",
    )
  }

  return {
    nodeEnv,
    trustedProxy: environment.TRUSTED_PROXY_CIDR?.trim() || "",
    host: environment.HOST || "0.0.0.0",
    port: Number(environment.PORT || 4100),
    webOrigin: environment.WEB_ORIGIN || "http://localhost:5173",
    publicWebUrl: (
      environment.PUBLIC_WEB_URL || "http://localhost:5173"
    ).replace(/\/$/, ""),
    sessionSecret,
    paymentMode,
    databaseUrl: environment.DATABASE_URL || "",
    tossClientKey,
    tossSecretKey,
    tossExpectedMid: environment.TOSS_EXPECTED_MID?.trim() || "",
  }
}
