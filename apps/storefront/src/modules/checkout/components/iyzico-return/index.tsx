"use client"

import { placeOrder } from "@lib/data/cart"
import LocalizedClientLink from "@modules/common/components/localized-client-link"
import { Heading, Text } from "@modules/common/components/ui"
import { useEffect, useRef, useState } from "react"

/**
 * Where the customer lands after the iyzico payment page.
 *
 * It does not trust anything in the URL: it just completes the cart. The backend's iyzico
 * provider then asks iyzico directly whether this cart was really paid, and the order is only
 * created if it was. On success `placeOrder` redirects to the order confirmation page.
 */
const IyzicoReturn = () => {
  const started = useRef(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Strict mode runs effects twice in development; only complete the cart once.
    if (started.current) {
      return
    }
    started.current = true

    placeOrder()
      .then((cart) => {
        // placeOrder redirects when an order was created; getting a cart back means it was not.
        if (cart) {
          setError("We could not confirm your payment.")
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
      })
  }, [])

  if (!error) {
    return (
      <div
        className="content-container py-24 flex flex-col items-center gap-y-4"
        data-testid="iyzico-return-loading"
      >
        <Heading level="h1" className="text-2xl-semi">
          Finalizing your payment…
        </Heading>
        <Text className="text-ui-fg-subtle">
          Please do not close or refresh this page.
        </Text>
      </div>
    )
  }

  return (
    <div
      className="content-container py-24 flex flex-col items-center gap-y-4 text-center"
      data-testid="iyzico-return-error"
    >
      <Heading level="h1" className="text-2xl-semi">
        Your payment was not completed
      </Heading>
      <Text className="text-ui-fg-subtle max-w-lg">
        No order was placed. If money left your account, it will be returned by your bank
        automatically; if you think this is a mistake, please contact us.
      </Text>
      <Text className="text-ui-fg-muted txt-small" data-testid="iyzico-return-error-detail">
        {error}
      </Text>
      <LocalizedClientLink
        href="/checkout?step=payment"
        className="underline text-ui-fg-interactive"
        data-testid="iyzico-return-retry"
      >
        Back to payment
      </LocalizedClientLink>
    </div>
  )
}

export default IyzicoReturn
