import {
  AbstractPaymentProvider,
  BigNumber,
  MedusaError,
  PaymentSessionStatus,
} from "@medusajs/framework/utils"
import type {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  Logger,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types"
import { formatPrice, IyzicoClient } from "./client"
import {
  CheckoutFormRetrieveResponse,
  IyzicoAddress,
  IyzicoBasketItem,
  IyzicoBuyer,
  IyzicoOptions,
  IyzicoSessionData,
} from "./types"

type InjectedDependencies = {
  logger: Logger
}

/**
 * Sent by the checkout-form API route inside the payment session `data` (key `checkout_request`).
 * The provider turns it into the iyzico initialize call and then DROPS it, so buyer details
 * are never stored on the payment session.
 */
export type IyzicoCheckoutRequest = {
  basket_id: string
  return_url: string
  buyer: IyzicoBuyer
  shipping_address: IyzicoAddress
  billing_address: IyzicoAddress
  basket_items: IyzicoBasketItem[]
}

type SessionDataWithRequest = IyzicoSessionData & {
  checkout_request?: IyzicoCheckoutRequest
}

type Verdict =
  | { state: "paid"; result: CheckoutFormRetrieveResponse }
  | { state: "pending"; result?: CheckoutFormRetrieveResponse }
  | { state: "failed"; reason: string }

const AMOUNT_TOLERANCE = 0.005

const toNumber = (value: unknown): number => Number(new BigNumber(value as any).numeric)
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

class IyzicoProviderService extends AbstractPaymentProvider<IyzicoOptions> {
  static identifier = "iyzico"

  protected readonly options_: IyzicoOptions
  protected readonly client_: IyzicoClient
  protected readonly logger_: Logger

  static validateOptions(options: Record<string, any>): void {
    const required = ["apiKey", "secretKey", "baseUrl", "backendPublicUrl", "storefrontUrl"]
    for (const key of required) {
      if (!options?.[key]) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `iyzico payment provider: option "${key}" is required (check IYZICO_* variables in .env)`
        )
      }
    }
  }

  constructor(container: InjectedDependencies, options: IyzicoOptions) {
    super(container, options)
    this.logger_ = container.logger
    this.options_ = options
    this.client_ = new IyzicoClient(options)
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  private isAllowedReturnUrl(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.options_.storefrontUrl).origin
    } catch {
      return false
    }
  }

  private fail(message: string, type = MedusaError.Types.INVALID_DATA): never {
    throw new MedusaError(type, message)
  }

  /**
   * Asks iyzico for the result of a checkout form and checks it against what THIS session
   * expects. The session `data` is readable (and in theory writable) from the storefront, so
   * nothing in it is trusted without this check.
   */
  private async verify(data: IyzicoSessionData): Promise<Verdict> {
    if (!data?.token || !data.session_id) {
      return { state: "pending" }
    }

    let result: CheckoutFormRetrieveResponse
    try {
      result = await this.client_.retrieveCheckoutForm(data.token, data.session_id)
    } catch (e) {
      this.logger_.error(`iyzico: could not retrieve checkout form: ${(e as Error).message}`)
      return { state: "failed", reason: (e as Error).message }
    }

    // Unfinished / abandoned payments come back as status "failure".
    if (result.status !== "success") {
      return { state: "pending", result }
    }
    if (result.paymentStatus !== "SUCCESS") {
      return { state: "failed", reason: `payment status is ${result.paymentStatus}` }
    }

    if (result.conversationId !== data.session_id || result.token !== data.token) {
      return { state: "failed", reason: "payment does not belong to this session" }
    }
    if (
      !data.currency_code ||
      result.currency?.toLowerCase() !== data.currency_code.toLowerCase()
    ) {
      return { state: "failed", reason: "payment currency does not match" }
    }
    if (
      data.amount === undefined ||
      Math.abs(Number(result.paidPrice) - data.amount) > AMOUNT_TOLERANCE
    ) {
      return { state: "failed", reason: "payment amount does not match" }
    }

    if (result.fraudStatus === -1) {
      return { state: "failed", reason: "payment was rejected by iyzico fraud checks" }
    }
    if (result.fraudStatus === 0) {
      return { state: "pending", result }
    }

    return { state: "paid", result }
  }

  private paidData(data: IyzicoSessionData, result: CheckoutFormRetrieveResponse): IyzicoSessionData {
    return {
      session_id: data.session_id,
      amount: data.amount,
      currency_code: data.currency_code,
      token: data.token,
      payment_id: result.paymentId,
      paid_price: Number(result.paidPrice),
      item_transactions: (result.itemTransactions ?? []).map((tx) => ({
        id: tx.paymentTransactionId,
        item_id: tx.itemId,
        paid_price: Number(tx.paidPrice),
        refunded: 0,
      })),
    }
  }

  // ---------------------------------------------------------------------------
  // AbstractPaymentProvider
  // ---------------------------------------------------------------------------

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    // The payment module adds `session_id` to `data` for every provider.
    const sessionId = input.data?.session_id as string | undefined
    if (!sessionId) {
      this.fail("iyzico: payment session id is missing", MedusaError.Types.UNEXPECTED_STATE)
    }

    const data: IyzicoSessionData = {
      session_id: sessionId,
      amount: toNumber(input.amount),
      currency_code: input.currency_code,
    }
    return { id: sessionId, data: data as Record<string, unknown>, status: PaymentSessionStatus.PENDING }
  }

  /**
   * Called when the cart changes (amount) and by the checkout-form route (with `checkout_request`).
   * - amount/currency changed  -> the old iyzico token is no longer valid, so it is dropped
   * - `checkout_request` given -> initialize a new iyzico checkout form and store token + page url
   */
  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const { checkout_request, ...stored } = (input.data ?? {}) as SessionDataWithRequest
    const amount = toNumber(input.amount)
    const currency = input.currency_code

    const unchanged =
      stored.amount !== undefined &&
      Math.abs(stored.amount - amount) < AMOUNT_TOLERANCE &&
      stored.currency_code?.toLowerCase() === currency.toLowerCase()

    let data: IyzicoSessionData = unchanged
      ? { ...stored }
      : { session_id: stored.session_id, amount, currency_code: currency }

    if (!checkout_request) {
      return { data: data as Record<string, unknown> }
    }

    if (!data.session_id) {
      this.fail("iyzico: payment session id is missing", MedusaError.Types.UNEXPECTED_STATE)
    }
    if (!this.isAllowedReturnUrl(checkout_request.return_url)) {
      this.fail("iyzico: return_url must be on the storefront origin")
    }

    const basketTotal = round2(
      checkout_request.basket_items.reduce((sum, item) => sum + Number(item.price), 0)
    )
    if (Math.abs(basketTotal - amount) > 0.01) {
      this.fail(
        `iyzico: basket total (${basketTotal}) does not match the payment amount (${amount})`
      )
    }

    const price = formatPrice(amount)

    // iyzico rejects empty strings for optional fields, and requires an ID number and phone
    // on the buyer. Fill those from the configured fallbacks when the cart has none.
    const dropEmpty = <T extends Record<string, unknown>>(obj: T): T =>
      Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== "" && v != null)) as T
    const buyer = dropEmpty({
      ...checkout_request.buyer,
      identityNumber:
        checkout_request.buyer.identityNumber ||
        this.options_.fallbackIdentityNumber ||
        "11111111111",
      gsmNumber:
        checkout_request.buyer.gsmNumber || this.options_.fallbackGsmNumber || "+905000000000",
    })

    let response
    try {
      response = await this.client_.initializeCheckoutForm({
        locale: this.options_.locale ?? "tr",
        conversationId: data.session_id,
        price,
        paidPrice: price,
        currency: currency.toUpperCase(),
        basketId: checkout_request.basket_id,
        paymentGroup: "PRODUCT",
        callbackUrl: `${this.options_.backendPublicUrl.replace(/\/$/, "")}/hooks/iyzico/callback/${data.session_id}`,
        buyer,
        shippingAddress: dropEmpty(checkout_request.shipping_address),
        billingAddress: dropEmpty(checkout_request.billing_address),
        basketItems: checkout_request.basket_items,
      })
    } catch (e) {
      this.logger_.error(`iyzico: checkout form initialize failed: ${(e as Error).message}`)
      this.fail(
        `iyzico could not start the payment: ${(e as Error).message}`,
        MedusaError.Types.UNEXPECTED_STATE
      )
    }

    if (!response.token || !response.paymentPageUrl) {
      this.fail("iyzico did not return a payment page", MedusaError.Types.UNEXPECTED_STATE)
    }

    data = {
      ...data,
      token: response.token,
      payment_page_url: response.paymentPageUrl,
      return_url: checkout_request.return_url,
    }
    return { data: data as Record<string, unknown> }
  }

  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const data = (input.data ?? {}) as IyzicoSessionData
    const verdict = await this.verify(data)

    if (verdict.state === "paid") {
      // Checkout Form is a one-step sale: money is already captured at iyzico.
      return {
        data: this.paidData(data, verdict.result) as Record<string, unknown>,
        status: PaymentSessionStatus.CAPTURED,
      }
    }
    if (verdict.state === "pending") {
      const status = verdict.result?.fraudStatus === 0
        ? PaymentSessionStatus.PENDING_AUTHORIZATION
        : PaymentSessionStatus.PENDING
      return { data: data as Record<string, unknown>, status }
    }

    this.logger_.warn(`iyzico: payment not authorized for session ${data.session_id}: ${verdict.reason}`)
    return { data: data as Record<string, unknown>, status: PaymentSessionStatus.ERROR }
  }

  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    // Already captured at authorization time (see authorizePayment).
    return { data: input.data }
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const data = (input.data ?? {}) as IyzicoSessionData
    const transactions = (data.item_transactions ?? []).map((tx) => ({ ...tx }))
    if (!data.payment_id || !transactions.length || !data.currency_code) {
      this.fail("iyzico: this payment has no refundable transactions", MedusaError.Types.NOT_ALLOWED)
    }

    let left = round2(toNumber(input.amount))
    for (const tx of transactions) {
      if (left <= 0) {
        break
      }
      const refundable = round2(tx.paid_price - tx.refunded)
      if (refundable <= 0) {
        continue
      }
      const take = Math.min(refundable, left)
      try {
        await this.client_.refund({
          paymentTransactionId: tx.id,
          price: take,
          currency: data.currency_code,
          conversationId: data.session_id,
        })
      } catch (e) {
        this.logger_.error(`iyzico: refund failed for transaction ${tx.id}: ${(e as Error).message}`)
        this.fail(`iyzico refund failed: ${(e as Error).message}`, MedusaError.Types.UNEXPECTED_STATE)
      }
      tx.refunded = round2(tx.refunded + take)
      left = round2(left - take)
    }

    if (left > 0) {
      this.fail(
        `iyzico: cannot refund more than what was paid (${left} left over)`,
        MedusaError.Types.NOT_ALLOWED
      )
    }

    return { data: { ...data, item_transactions: transactions } as Record<string, unknown> }
  }

  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    const data = (input.data ?? {}) as IyzicoSessionData

    // Nothing was charged yet: nothing to cancel at iyzico.
    if (!data.payment_id) {
      return { data: data as Record<string, unknown> }
    }

    try {
      await this.client_.cancel({ paymentId: data.payment_id, conversationId: data.session_id })
    } catch (e) {
      // iyzico only allows cancelling on the day of payment; after that use a refund.
      this.fail(
        `iyzico could not cancel the payment (use a refund after the payment day): ${(e as Error).message}`,
        MedusaError.Types.NOT_ALLOWED
      )
    }
    return { data: { ...data, canceled: true } as Record<string, unknown> }
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    // Nothing is held at iyzico for an unpaid session; the token simply expires.
    return { data: input.data }
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    return { data: input.data }
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const data = (input.data ?? {}) as IyzicoSessionData
    if (data.canceled) {
      return { status: PaymentSessionStatus.CANCELED }
    }
    const verdict = await this.verify(data)
    switch (verdict.state) {
      case "paid":
        return { status: PaymentSessionStatus.CAPTURED }
      case "failed":
        return { status: PaymentSessionStatus.ERROR }
      default:
        return { status: PaymentSessionStatus.PENDING }
    }
  }

  /**
   * Optional backup path: iyzico calls /hooks/payment/iyzico_iyzico when a payment completes,
   * so the order still gets placed if the customer closes the browser after paying.
   * Requires webhooks (and the V3 signature) to be enabled by iyzico for the merchant account.
   */
  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    const body = (payload.data ?? {}) as {
      iyziEventType?: string
      iyziPaymentId?: string | number
      token?: string
      paymentConversationId?: string
      status?: string
    }
    const signature = payload.headers?.["x-iyz-signature-v3"] as string | undefined

    if (!this.client_.verifyWebhookSignature(body, signature)) {
      this.logger_.warn("iyzico: webhook with invalid or missing signature ignored")
      return { action: "not_supported" }
    }
    if (body.iyziEventType !== "CHECKOUT_FORM_AUTH" || body.status !== "SUCCESS") {
      return { action: "not_supported" }
    }
    if (!body.token || !body.paymentConversationId) {
      return { action: "not_supported" }
    }

    // Do not trust the webhook body for the amount: ask iyzico.
    const result = await this.client_.retrieveCheckoutForm(body.token, body.paymentConversationId)
    if (
      result.status !== "success" ||
      result.paymentStatus !== "SUCCESS" ||
      result.conversationId !== body.paymentConversationId ||
      result.fraudStatus !== 1
    ) {
      return { action: "not_supported" }
    }

    return {
      action: "captured",
      data: {
        session_id: body.paymentConversationId,
        amount: new BigNumber(Number(result.paidPrice)),
      },
    }
  }
}

export default IyzicoProviderService
