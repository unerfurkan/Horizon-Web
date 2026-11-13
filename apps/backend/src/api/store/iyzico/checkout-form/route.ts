import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"
import type { IyzicoCheckoutRequest } from "../../../../modules/iyzico/service"
import type { IyzicoSessionData } from "../../../../modules/iyzico/types"

const PROVIDER_ID = "pp_iyzico_iyzico"

type Body = {
  cart_id?: string
  return_url?: string
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

const countryName = (code?: string | null) => {
  if (!code) {
    return "Turkey"
  }
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) ?? code
  } catch {
    return code
  }
}

const cleanIp = (ip?: string) => {
  const value = ip?.replace(/^::ffff:/, "")
  return value && value !== "::1" && value !== "127.0.0.1" ? value : undefined
}

/**
 * POST /store/iyzico/checkout-form  { cart_id, return_url }
 *
 * Starts an iyzico Checkout Form for the cart's iyzico payment session and returns the iyzico
 * page the browser must be sent to. All iyzico calls happen inside the payment provider.
 */
export async function POST(req: MedusaRequest<Body>, res: MedusaResponse) {
  const { cart_id, return_url } = req.body ?? {}
  if (!cart_id || !return_url) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "cart_id and return_url are required")
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data: carts } = await query.graph({
    entity: "cart",
    fields: [
      "id",
      "email",
      "total",
      "currency_code",
      "customer.id",
      "customer.first_name",
      "customer.last_name",
      "customer.phone",
      "items.id",
      "items.title",
      "items.product_title",
      "items.product_collection",
      "items.requires_shipping",
      // Medusa only computes `items.total` / `shipping_methods.total` when the inputs for the
      // calculation (quantity, unit_price, amount) are requested too.
      "items.quantity",
      "items.unit_price",
      "items.subtotal",
      "items.total",
      "shipping_methods.id",
      "shipping_methods.name",
      "shipping_methods.amount",
      "shipping_methods.subtotal",
      "shipping_methods.total",
      "shipping_address.*",
      "billing_address.*",
      "payment_collection.id",
      "payment_collection.payment_sessions.id",
      "payment_collection.payment_sessions.provider_id",
      "payment_collection.payment_sessions.status",
      "payment_collection.payment_sessions.amount",
      "payment_collection.payment_sessions.currency_code",
      "payment_collection.payment_sessions.data",
    ],
    filters: { id: cart_id },
  })

  const cart = carts[0] as any
  if (!cart) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, "Cart not found")
  }

  // Prefer the pending session: a failed earlier attempt may have left an errored one behind.
  const iyzicoSessions = (cart.payment_collection?.payment_sessions ?? []).filter(
    (s: any) => s.provider_id === PROVIDER_ID
  )
  const session =
    iyzicoSessions.find((s: any) => s.status === "pending") ?? iyzicoSessions[0]
  if (!session) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "No iyzico payment session on this cart. Initialize the payment session first."
    )
  }
  if (!cart.email || !cart.shipping_address) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "The cart needs an email and a shipping address before paying"
    )
  }

  // --- basket: iyzico needs line items whose prices add up exactly to the amount ----------
  const basket = [
    ...(cart.items ?? []).map((item: any) => ({
      id: String(item.id),
      name: String(item.product_title ?? item.title ?? "Item"),
      category1: String(item.product_collection ?? "General"),
      itemType: (item.requires_shipping === false ? "VIRTUAL" : "PHYSICAL") as
        | "PHYSICAL"
        | "VIRTUAL",
      price: round2(Number(item.total ?? Number(item.unit_price) * Number(item.quantity))),
    })),
    ...(cart.shipping_methods ?? []).map((method: any) => ({
      id: String(method.id),
      name: String(method.name ?? "Shipping"),
      category1: "Shipping",
      itemType: "VIRTUAL" as const,
      price: round2(Number(method.total ?? method.amount)),
    })),
  ].filter((line) => line.price > 0)

  if (!basket.length) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "Nothing to pay for in this cart")
  }

  // Absorb tiny rounding differences into the biggest line; anything larger is a real problem.
  const amount = Number(session.amount)
  const diff = round2(amount - basket.reduce((sum, line) => sum + line.price, 0))
  if (diff !== 0) {
    if (Math.abs(diff) > 1) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Cart items do not add up to the payment amount. Refresh the cart and try again."
      )
    }
    const biggest = basket.reduce((a, b) => (b.price > a.price ? b : a))
    biggest.price = round2(biggest.price + diff)
  }

  // --- buyer and addresses ---------------------------------------------------------------
  const ship = cart.shipping_address
  const bill = cart.billing_address ?? ship
  const toAddress = (a: any) => ({
    address: [a.address_1, a.address_2].filter(Boolean).join(" ") || "-",
    contactName: [a.first_name, a.last_name].filter(Boolean).join(" ") || "Customer",
    city: a.city || a.province || "-",
    country: countryName(a.country_code),
    zipCode: a.postal_code ?? "",
  })

  const checkoutRequest: IyzicoCheckoutRequest = {
    basket_id: cart.id,
    return_url,
    buyer: {
      id: cart.customer?.id ?? cart.id,
      name: ship.first_name || cart.customer?.first_name || "Customer",
      surname: ship.last_name || cart.customer?.last_name || "Customer",
      identityNumber: "",
      email: cart.email,
      gsmNumber: ship.phone || cart.customer?.phone || "",
      registrationAddress: toAddress(ship).address,
      city: toAddress(ship).city,
      country: toAddress(ship).country,
      zipCode: ship.postal_code ?? "",
      ip: cleanIp(req.ip),
    },
    shipping_address: toAddress(ship),
    billing_address: toAddress(bill),
    basket_items: basket.map((line) => ({
      id: line.id,
      name: line.name,
      category1: line.category1,
      itemType: line.itemType,
      price: String(line.price),
    })),
  }

  // The provider turns `checkout_request` into the iyzico call and stores token + page url.
  const paymentModule = req.scope.resolve(Modules.PAYMENT)
  const updated = await paymentModule.updatePaymentSession({
    id: session.id,
    amount: session.amount,
    currency_code: session.currency_code,
    data: { ...(session.data ?? {}), checkout_request: checkoutRequest },
  })

  const data = (updated.data ?? {}) as IyzicoSessionData
  if (!data.payment_page_url) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "iyzico did not return a payment page"
    )
  }

  res.json({ payment_page_url: data.payment_page_url })
}
