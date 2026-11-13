import {
  buildAuthorizationHeader,
  formatPrice,
  hmacSha256Hex,
  IyzicoClient,
  normalizePrice,
} from "../client"

const options = {
  apiKey: "api-key",
  secretKey: "secret-key",
  baseUrl: "https://sandbox-api.iyzipay.com",
  backendPublicUrl: "https://backend.example.com",
  storefrontUrl: "https://shop.example.com",
}

describe("iyzico prices", () => {
  it("strips trailing zeros like iyzico does when signing", () => {
    expect(normalizePrice("50.00")).toBe("50")
    expect(normalizePrice("10.50")).toBe("10.5")
    expect(normalizePrice("10.55")).toBe("10.55")
    expect(normalizePrice(7)).toBe("7")
    expect(normalizePrice(undefined)).toBe("")
  })

  it("formats request prices with at most 2 decimals", () => {
    expect(formatPrice(10.5)).toBe("10.5")
    expect(formatPrice(100)).toBe("100")
    expect(formatPrice(0.1 + 0.2)).toBe("0.3")
  })
})

describe("buildAuthorizationHeader", () => {
  it("builds IYZWSv2 header = base64(apiKey&randomKey&HMAC(randomKey+path+body))", () => {
    const header = buildAuthorizationHeader({
      apiKey: "api-key",
      secretKey: "secret-key",
      path: "/payment/bin/check",
      body: '{"binNumber":"535805"}',
      randomKey: "123456789",
    })

    expect(header.startsWith("IYZWSv2 ")).toBe(true)
    const decoded = Buffer.from(header.slice("IYZWSv2 ".length), "base64").toString()
    const expectedSignature = hmacSha256Hex(
      '123456789/payment/bin/check{"binNumber":"535805"}',
      "secret-key"
    )
    expect(decoded).toBe(
      `apiKey:api-key&randomKey:123456789&signature:${expectedSignature}`
    )
  })
})

describe("IyzicoClient", () => {
  const originalFetch = global.fetch
  afterEach(() => {
    global.fetch = originalFetch
  })

  const mockFetch = (json: unknown) => {
    global.fetch = jest.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify(json),
    })) as unknown as typeof fetch
  }

  const retrieveFields = {
    status: "success",
    paymentStatus: "SUCCESS",
    paymentId: "100",
    currency: "TRY",
    basketId: "cart_1",
    conversationId: "payses_1",
    paidPrice: 50,
    price: 50,
    token: "tok",
  }
  const retrieveSignature = hmacSha256Hex(
    ["SUCCESS", "100", "TRY", "cart_1", "payses_1", "50", "50", "tok"].join(":"),
    options.secretKey
  )

  it("accepts a retrieve response with a valid signature", async () => {
    mockFetch({ ...retrieveFields, signature: retrieveSignature })
    const res = await new IyzicoClient(options).retrieveCheckoutForm("tok", "payses_1")
    expect(res.paymentId).toBe("100")
  })

  it("rejects a retrieve response with a wrong signature", async () => {
    mockFetch({ ...retrieveFields, paidPrice: 1, signature: retrieveSignature })
    await expect(
      new IyzicoClient(options).retrieveCheckoutForm("tok", "payses_1")
    ).rejects.toThrow("signature")
  })

  it("does not throw for unfinished payments (status failure)", async () => {
    mockFetch({ status: "failure", errorMessage: "token not found" })
    const res = await new IyzicoClient(options).retrieveCheckoutForm("tok")
    expect(res.status).toBe("failure")
  })

  it("sends the Authorization header and a JSON body to the right path", async () => {
    mockFetch({ status: "success", token: "t", paymentPageUrl: "https://x", conversationId: "c" })
    await new IyzicoClient(options).initializeCheckoutForm({
      conversationId: "c",
      price: "1",
      paidPrice: "1",
      currency: "TRY",
      basketId: "b",
      callbackUrl: "https://cb",
    } as any)

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0]
    expect(url).toBe(
      "https://sandbox-api.iyzipay.com/payment/iyzipos/checkoutform/initialize/auth/ecom"
    )
    expect(init.headers.Authorization.startsWith("IYZWSv2 ")).toBe(true)
    expect(init.headers["x-iyzi-rnd"]).toBeTruthy()
  })

  it("verifies webhook signatures (V3)", () => {
    const client = new IyzicoClient(options)
    const payload = {
      iyziEventType: "CHECKOUT_FORM_AUTH",
      iyziPaymentId: 777,
      token: "tok",
      paymentConversationId: "payses_1",
      status: "SUCCESS",
    }
    const good = hmacSha256Hex(
      "secret-keyCHECKOUT_FORM_AUTH777tokpayses_1SUCCESS",
      "secret-key"
    )
    expect(client.verifyWebhookSignature(payload, good)).toBe(true)
    expect(client.verifyWebhookSignature({ ...payload, status: "FAILURE" }, good)).toBe(false)
    expect(client.verifyWebhookSignature(payload, undefined)).toBe(false)
  })
})
