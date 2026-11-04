import { afterEach, describe, expect, it, vi } from "vitest"
import { confirmTossPayment } from "./toss.js"

const payment = {
  status: "DONE",
  orderId: "QR-test-order",
  paymentKey: "opaque/payment/key",
  totalAmount: 55000,
  mId: "test-mid",
}

afterEach(() => vi.unstubAllGlobals())

describe("Toss confirmation recovery", () => {
  it("recovers a completed approval from a duplicate callback", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ code: "ALREADY_PROCESSED_PAYMENT" }, { status: 400 }),
      )
      .mockResolvedValueOnce(Response.json(payment))
    vi.stubGlobal("fetch", fetcher)

    await expect(
      confirmTossPayment(
        "test-secret",
        payment.paymentKey,
        payment.orderId,
        payment.totalAmount,
        payment.mId,
      ),
    ).resolves.toEqual(payment)
    expect(fetcher.mock.calls[1]?.[0]).toMatch(/\/opaque%2Fpayment%2Fkey$/)
  })

  it("refuses a provider lookup for a different amount after a timeout", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"))
      .mockResolvedValueOnce(Response.json({ ...payment, totalAmount: 1 }))
    vi.stubGlobal("fetch", fetcher)

    await expect(
      confirmTossPayment(
        "test-secret",
        payment.paymentKey,
        payment.orderId,
        payment.totalAmount,
        payment.mId,
      ),
    ).rejects.toMatchObject({ code: "PAYMENT_NOT_CONFIRMED" })
  })
})
