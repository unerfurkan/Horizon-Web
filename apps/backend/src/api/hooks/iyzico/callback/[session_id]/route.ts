import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import type { IyzicoSessionData } from "../../../../../modules/iyzico/types"

/**
 * POST /hooks/iyzico/callback/:session_id
 *
 * iyzico sends the customer's browser here (form POST with a `token`) after the payment page.
 * We do NOT decide anything here: the result is checked by the payment provider when the
 * storefront completes the cart (authorizePayment asks iyzico directly). This route only sends
 * the browser back to the storefront.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const sessionId = req.params.session_id
  const storefrontUrl = process.env.STOREFRONT_URL

  let returnUrl: string | undefined
  try {
    const paymentModule = req.scope.resolve(Modules.PAYMENT)
    const session = await paymentModule.retrievePaymentSession(sessionId, {
      select: ["id", "data"],
    })
    returnUrl = (session.data as IyzicoSessionData | undefined)?.return_url
  } catch {
    // unknown session id: handled below
  }

  let target: URL | undefined
  try {
    if (returnUrl && storefrontUrl) {
      const candidate = new URL(returnUrl)
      // never redirect anywhere except the storefront
      if (candidate.origin === new URL(storefrontUrl).origin) {
        target = candidate
      }
    }
  } catch {
    // invalid URL: handled below
  }

  if (!target) {
    res.status(400).send("Unknown or expired payment session.")
    return
  }

  target.searchParams.set("session_id", sessionId)
  // 303 turns iyzico's POST into a GET on the storefront
  res.redirect(303, target.toString())
}
