export type IyzicoOptions = {
  apiKey: string
  secretKey: string
  /** https://sandbox-api.iyzipay.com for sandbox, https://api.iyzipay.com for production */
  baseUrl: string
  /** Publicly reachable HTTPS URL of this Medusa backend (iyzico posts the payment result here). */
  backendPublicUrl: string
  /** Storefront origin. Customers are only ever redirected back to URLs under this origin. */
  storefrontUrl: string
  /** "tr" (default) or "en" - language of the iyzico payment page. */
  locale?: "tr" | "en"
  /**
   * iyzico requires a Turkish national ID number on the buyer. Used only when the customer
   * did not provide one. Sandbox accepts test values; production may require a real one.
   */
  fallbackIdentityNumber?: string
  /** Used when the cart has no phone number on the shipping address or customer. */
  fallbackGsmNumber?: string
}

export type IyzicoAddress = {
  address: string
  contactName: string
  city: string
  country: string
  zipCode?: string
}

export type IyzicoBuyer = {
  id: string
  name: string
  surname: string
  identityNumber: string
  email: string
  gsmNumber: string
  registrationAddress: string
  city: string
  country: string
  zipCode?: string
  ip?: string
}

export type IyzicoBasketItem = {
  id: string
  price: string
  name: string
  category1: string
  itemType: "PHYSICAL" | "VIRTUAL"
}

export type CheckoutFormInitializeRequest = {
  locale?: string
  conversationId: string
  price: string
  paidPrice: string
  currency: string
  basketId: string
  paymentGroup?: "PRODUCT" | "LISTING" | "SUBSCRIPTION"
  callbackUrl: string
  buyer: IyzicoBuyer
  shippingAddress: IyzicoAddress
  billingAddress: IyzicoAddress
  basketItems: IyzicoBasketItem[]
  enabledInstallments?: number[]
}

type IyzicoBaseResponse = {
  status: "success" | "failure"
  errorCode?: string
  errorMessage?: string
  errorGroup?: string
  locale?: string
  systemTime?: number
  conversationId?: string
}

export type CheckoutFormInitializeResponse = IyzicoBaseResponse & {
  token?: string
  paymentPageUrl?: string
  tokenExpireTime?: number
  signature?: string
}

export type IyzicoItemTransaction = {
  itemId: string
  paymentTransactionId: string
  transactionStatus?: number
  price: number | string
  paidPrice: number | string
}

export type CheckoutFormRetrieveResponse = IyzicoBaseResponse & {
  token?: string
  paymentStatus?: string
  paymentId?: string
  price?: number | string
  paidPrice?: number | string
  currency?: string
  basketId?: string
  fraudStatus?: number
  itemTransactions?: IyzicoItemTransaction[]
  signature?: string
}

export type RefundResponse = IyzicoBaseResponse & {
  paymentId?: string
  paymentTransactionId?: string
  price?: number | string
  currency?: string
  signature?: string
}

export type CancelResponse = IyzicoBaseResponse & {
  paymentId?: string
  price?: number | string
  currency?: string
}

/** What we keep in the Medusa payment session / payment `data`. Never put secrets here. */
export type IyzicoSessionData = {
  session_id?: string
  /** Amount and currency the session was created for. Used to detect cart changes. */
  amount?: number
  currency_code?: string
  /** Set when the checkout form was initialized. */
  token?: string
  payment_page_url?: string
  /** Where the customer is sent after iyzico (must be under the storefront origin). */
  return_url?: string
  /** Set after the payment was verified as successful. */
  payment_id?: string
  paid_price?: number
  item_transactions?: {
    id: string
    item_id: string
    paid_price: number
    refunded: number
  }[]
  canceled?: boolean
}
