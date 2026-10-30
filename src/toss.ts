const TOSS_API = "https://api.tosspayments.com/v1/payments"

export class TossError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 502,
    public readonly code = "TOSS_PAYMENT_ERROR",
  ) {
    super(message)
  }
}

function authorization(secretKey: string) {
  return `Basic ${Buffer.from(`${secretKey}:`, "utf8").toString("base64")}`
}

async function tossRequest(
  path: string,
  secretKey: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
) {
  const response = await fetch(`${TOSS_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: authorization(secretKey),
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  const result = (await response
    .json()
    .catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    throw new TossError(
      typeof result.message === "string"
        ? result.message
        : "결제 승인에 실패했습니다.",
      response.status >= 500 ? 502 : 400,
      typeof result.code === "string" ? result.code : "TOSS_PAYMENT_ERROR",
    )
  }
  return result
}

export function confirmTossPayment(
  secretKey: string,
  paymentKey: string,
  orderId: string,
  amount: number,
) {
  return tossRequest(
    "/confirm",
    secretKey,
    { paymentKey, orderId, amount },
    `confirm-${orderId}`,
  )
}

export function cancelTossPayment(
  secretKey: string,
  paymentKey: string,
  reason: string,
  orderId: string,
) {
  return tossRequest(
    `/${encodeURIComponent(paymentKey)}/cancel`,
    secretKey,
    { cancelReason: reason },
    `cancel-${orderId}`,
  )
}
