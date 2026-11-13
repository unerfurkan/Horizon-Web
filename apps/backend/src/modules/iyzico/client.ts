import { createHmac, randomBytes, timingSafeEqual } from "crypto"
import {
  CancelResponse,
  CheckoutFormInitializeRequest,
  CheckoutFormInitializeResponse,
  CheckoutFormRetrieveResponse,
  IyzicoOptions,
  RefundResponse,
} from "./types"

const PATHS = {
  checkoutFormInitialize: "/payment/iyzipos/checkoutform/initialize/auth/ecom",
  checkoutFormRetrieve: "/payment/iyzipos/checkoutform/auth/ecom/detail",
  refund: "/payment/refund",
  cancel: "/payment/cancel",
} as const

export class IyzicoApiError extends Error {
  code?: string
  group?: string

  constructor(message: string, code?: string, group?: string) {
    super(message)
    this.name = "IyzicoApiError"
    this.code = code
    this.group = group
  }
}

export function hmacSha256Hex(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("hex")
}

/**
 * Builds the `Authorization` header value (IYZWSv2).
 *   signature = HMACSHA256(randomKey + uriPath + body, secretKey)  (hex)
 *   header    = "IYZWSv2 " + base64("apiKey:<k>&randomKey:<r>&signature:<s>")
 */
export function buildAuthorizationHeader(args: {
  apiKey: string
  secretKey: string
  path: string
  body: string
  randomKey: string
}): string {
  const { apiKey, secretKey, path, body, randomKey } = args
  const signature = hmacSha256Hex(randomKey + path + body, secretKey)
  const base64 = Buffer.from(
    `apiKey:${apiKey}&randomKey:${randomKey}&signature:${signature}`
  ).toString("base64")
  return `IYZWSv2 ${base64}`
}

/** iyzico signs prices without trailing zeros: "50.00" -> "50", "10.50" -> "10.5". */
export function normalizePrice(value: string | number | undefined | null): string {
  if (value === undefined || value === null) {
    return ""
  }
  const str = String(value)
  if (!str.includes(".")) {
    return str
  }
  return str.replace(/0+$/, "").replace(/\.$/, "")
}

/** Formats an amount for iyzico request bodies: at most 2 decimals, no trailing zeros. */
export function formatPrice(value: number): string {
  return normalizePrice(value.toFixed(2))
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

export class IyzicoClient {
  constructor(private readonly options: IyzicoOptions) {}

  private async post<T>(path: string, payload: Record<string, unknown>): Promise<T> {
    const body = JSON.stringify(payload)
    const randomKey = `${Date.now()}${randomBytes(6).toString("hex")}`

    const response = await fetch(`${this.options.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-iyzi-rnd": randomKey,
        Authorization: buildAuthorizationHeader({
          apiKey: this.options.apiKey,
          secretKey: this.options.secretKey,
          path,
          body,
          randomKey,
        }),
      },
      body,
    })

    const text = await response.text()
    try {
      return JSON.parse(text) as T
    } catch {
      throw new IyzicoApiError(
        `iyzico returned a non-JSON response (HTTP ${response.status})`
      )
    }
  }

  private assertSuccess(res: {
    status?: string
    errorMessage?: string
    errorCode?: string
    errorGroup?: string
  }) {
    if (res.status !== "success") {
      throw new IyzicoApiError(
        res.errorMessage ?? "iyzico request failed",
        res.errorCode,
        res.errorGroup
      )
    }
  }

  /** Signature check for responses. Only enforced when iyzico actually sent a signature. */
  private assertSignature(fields: string[], signature: string | undefined) {
    if (!signature) {
      return
    }
    const expected = hmacSha256Hex(fields.join(":"), this.options.secretKey)
    if (!safeEqual(expected, signature)) {
      throw new IyzicoApiError("iyzico response signature is invalid")
    }
  }

  async initializeCheckoutForm(
    request: CheckoutFormInitializeRequest
  ): Promise<CheckoutFormInitializeResponse> {
    const res = await this.post<CheckoutFormInitializeResponse>(
      PATHS.checkoutFormInitialize,
      request as unknown as Record<string, unknown>
    )
    this.assertSuccess(res)
    this.assertSignature([res.conversationId ?? "", res.token ?? ""], res.signature)
    return res
  }

  /**
   * Returns the raw result. Does NOT throw when the payment is unfinished or failed
   * (iyzico answers those with status "failure"); callers decide what that means.
   * Throws only when a signature is present and wrong.
   */
  async retrieveCheckoutForm(
    token: string,
    conversationId?: string
  ): Promise<CheckoutFormRetrieveResponse> {
    const res = await this.post<CheckoutFormRetrieveResponse>(PATHS.checkoutFormRetrieve, {
      locale: this.options.locale ?? "tr",
      token,
      ...(conversationId ? { conversationId } : {}),
    })

    if (res.status === "success") {
      this.assertSignature(
        [
          res.paymentStatus ?? "",
          res.paymentId ?? "",
          res.currency ?? "",
          res.basketId ?? "",
          res.conversationId ?? "",
          normalizePrice(res.paidPrice),
          normalizePrice(res.price),
          res.token ?? "",
        ],
        res.signature
      )
    }
    return res
  }

  async refund(args: {
    paymentTransactionId: string
    price: number
    currency: string
    conversationId?: string
  }): Promise<RefundResponse> {
    const res = await this.post<RefundResponse>(PATHS.refund, {
      locale: this.options.locale ?? "tr",
      paymentTransactionId: args.paymentTransactionId,
      price: formatPrice(args.price),
      currency: args.currency.toUpperCase(),
      ...(args.conversationId ? { conversationId: args.conversationId } : {}),
    })
    this.assertSuccess(res)
    return res
  }

  async cancel(args: { paymentId: string; conversationId?: string }): Promise<CancelResponse> {
    const res = await this.post<CancelResponse>(PATHS.cancel, {
      locale: this.options.locale ?? "tr",
      paymentId: args.paymentId,
      ...(args.conversationId ? { conversationId: args.conversationId } : {}),
    })
    this.assertSuccess(res)
    return res
  }

  /**
   * Webhook signature (X-IYZ-SIGNATURE-V3) for the Checkout Form / HPP format:
   *   HMACSHA256(secretKey + iyziEventType + iyziPaymentId + token + paymentConversationId + status, secretKey)
   */
  verifyWebhookSignature(
    payload: {
      iyziEventType?: string
      iyziPaymentId?: string | number
      token?: string
      paymentConversationId?: string
      status?: string
    },
    headerSignature: string | undefined
  ): boolean {
    if (!headerSignature) {
      return false
    }
    const data =
      this.options.secretKey +
      (payload.iyziEventType ?? "") +
      (payload.iyziPaymentId ?? "") +
      (payload.token ?? "") +
      (payload.paymentConversationId ?? "") +
      (payload.status ?? "")
    return safeEqual(hmacSha256Hex(data, this.options.secretKey), headerSignature)
  }
}
