"use server"

import { sdk } from "@lib/config"
import { getAuthHeaders, getCacheOptions } from "./cookies"
import { HttpTypes } from "@medusajs/types"
import medusaError from "@lib/util/medusa-error"

/**
 * Asks the backend to start an iyzico checkout form for the cart.
 * Returns the iyzico page the browser must be sent to.
 */
export const startIyzicoCheckout = async (
  cartId: string,
  returnUrl: string
): Promise<{ payment_page_url: string }> => {
  const headers = {
    ...(await getAuthHeaders()),
  }

  return sdk.client
    .fetch<{ payment_page_url: string }>(`/store/iyzico/checkout-form`, {
      method: "POST",
      body: { cart_id: cartId, return_url: returnUrl },
      headers,
    })
    .catch(medusaError)
}

export const listCartPaymentMethods = async (regionId: string) => {
  const headers = {
    ...(await getAuthHeaders()),
  }

  const next = {
    ...(await getCacheOptions("payment_providers")),
  }

  return sdk.client
    .fetch<HttpTypes.StorePaymentProviderListResponse>(
      `/store/payment-providers`,
      {
        method: "GET",
        query: { region_id: regionId },
        headers,
        next,
        cache: "force-cache",
      }
    )
    .then(({ payment_providers }) =>
      payment_providers.sort((a, b) => {
        return a.id > b.id ? 1 : -1
      })
    )
    .catch(() => {
      return null
    })
}
