export type AppConfig = {
  nodeEnv: "development" | "test" | "production"
  host: string
  port: number
  webOrigin: string
  publicWebUrl: string
  sessionSecret: string
  paymentMode: "demo" | "toss"
  databaseUrl: string
  tossClientKey: string
  tossSecretKey: string
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
  if (paymentMode === "toss" && (!tossClientKey || !tossSecretKey)) {
    throw new Error(
      "TOSS_CLIENT_KEY and TOSS_SECRET_KEY are required when PAYMENT_MODE=toss",
    )
  }

  return {
    nodeEnv,
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
  }
}
