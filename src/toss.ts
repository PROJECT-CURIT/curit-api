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

export async function confirmTossPayment(
  secretKey: string,
  paymentKey: string,
  orderId: string,
  amount: number,
  expectedMid?: string,
) {
  let payment: Record<string, unknown>
  try {
    payment = await tossRequest(
      "/confirm",
      secretKey,
      { paymentKey, orderId, amount },
      `confirm-${orderId}`,
    )
  } catch (error) {
    const uncertain =
      error instanceof TossError
        ? error.code === "ALREADY_PROCESSED_PAYMENT" || error.statusCode === 502
        : error instanceof TypeError ||
          (error instanceof Error && error.name === "TimeoutError")
    if (!uncertain) throw error
    const status = await fetch(
      `${TOSS_API}/${encodeURIComponent(paymentKey)}`,
      {
        headers: { Authorization: authorization(secretKey) },
        signal: AbortSignal.timeout(5000),
      },
    )
    if (!status.ok) throw error
    payment = ((await status.json()) as Record<string, unknown>)
  }
  if (
    payment.status !== "DONE" ||
    payment.orderId !== orderId ||
    payment.paymentKey !== paymentKey ||
    payment.totalAmount !== amount ||
    (expectedMid && payment.mId !== expectedMid)
  ) {
    throw new TossError(
      "결제 완료 상태를 확인하지 못했어요.",
      409,
      "PAYMENT_NOT_CONFIRMED",
    )
  }
  return payment
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
