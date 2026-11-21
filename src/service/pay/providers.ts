// The payment providers' origins (contract C11, the card payment, check 6; the secure card checkout design, section 8.4;
// board ab-sta.5). The act fills card fields only inside a frame of one of these origins, and an agent's tab may show a
// provider's hosted payment page of one of them (C11, check 6). A first value, from the providers' documentation of their
// hosted card fields and hosted payment pages; the operator can extend it in the Browser pane later (the design).
//
// The tests' provider (`https://pay.localhost`, the local test merchant of test/fixtures/pay-merchant/) is never in this
// list: a test gives it through the option `extra` (PayRequests' `providerOrigins`), and only the test flag
// `--test-provider-origin` of `service --test --card-pay` sets it, with a *.localhost origin (main.ts; board ab-sta.8).

/** The hosted card fields' and hosted payment pages' origins of the first build. */
export const PROVIDER_ORIGINS: readonly string[] = Object.freeze([
  // Stripe: the iframes of Stripe Elements, and the hosted page of Stripe Checkout.
  "https://js.stripe.com",
  "https://checkout.stripe.com",
  // Braintree: Hosted Fields.
  "https://assets.braintreegateway.com",
  // Square: the Web Payments SDK's card iframe.
  "https://web.squarecdn.com",
  // Adyen: the secured fields, on the live regions' checkoutshopper hosts.
  "https://checkoutshopper-live.adyen.com",
  "https://checkoutshopper-live-us.adyen.com",
  "https://checkoutshopper-live-au.adyen.com",
  "https://checkoutshopper-live-apse.adyen.com",
  "https://checkoutshopper-live-in.adyen.com",
  // Shopify: the card fields of Shopify's checkout.
  "https://checkout.pci.shopifyinc.com",
  // Authorize.net: the Accept Hosted payment form.
  "https://accept.authorize.net",
  // Cybersource: the Flex Microform fields.
  "https://flex.cybersource.com",
  // Spreedly: the iFrame payment fields.
  "https://core.spreedly.com",
  // PayPal: the card fields.
  "https://www.paypal.com",
]);

/**
 * True when `origin` is a payment provider's origin: on PROVIDER_ORIGINS, or on `extra` (the tests' option only). The
 * compare is of whole origins as the WHATWG URL parser gives them, so `https://js.stripe.com.example` or a path is none.
 */
export function isProviderOrigin(origin: string, extra: readonly string[] = []): boolean {
  if (typeof origin !== "string" || !URL.canParse(origin) || new URL(origin).origin !== origin) return false;
  return PROVIDER_ORIGINS.includes(origin) || extra.includes(origin);
}
