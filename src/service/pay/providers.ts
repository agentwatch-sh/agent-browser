// The payment providers (contract C11, the card payment, check 6 and the act's rules; the secure card checkout design,
// sections 8.4 and 8.6; boards ab-sta.5 and ab-sta.8). Each provider has two lists:
//
// - `frames`: the origins of its hosted card fields and its hosted payment pages. The act fills card fields only inside a
//   frame of one of these origins, and an agent's tab may show a provider's hosted payment page of one of them (C11,
//   check 6). PROVIDER_ORIGINS and isProviderOrigin are these origins only: the field finder, check 6, the act page's
//   origin.
// - `api`: the origins that its frames and its script call for the payment (its API, its tokenizer, its fraud and 3-D
//   Secure frames). The act's rules hold the act's provider's frame and API origins from the start (board ab-sta.8: Chrome
//   applies the act's rules before the act's Fetch sees a request, so the act cannot learn an origin after the press),
//   and the guard lets a body with the card's number go only to the act's provider (guard.ts).
//
// Both lists are a first value, from the providers' documentation as the builder knows it (no request to the internet
// made it). The Mac stage checks them against each provider's real pages before a real purchase; the operator can
// extend them in the Browser pane later (the design).
//
// The tests' provider (`http://pay.localhost:<port>` and its API origin, the local test merchant of
// test/fixtures/pay-merchant/) is never in these lists: a test gives it through its options (PayRequests' and the act's
// `providerOrigins`, the act's `providerApis`), and only the test flags `--test-provider-origin` and
// `--test-provider-api` of `service --test --card-pay` set it, with *.localhost origins (main.ts; board ab-sta.8).

/** One payment provider: its name, its card-field frames' and hosted pages' origins, and its API origins. */
export type Provider = { readonly name: string; readonly frames: readonly string[]; readonly api: readonly string[] };

/** The providers of the first build (a first value: the Mac stage checks each list). */
export const PROVIDERS: readonly Provider[] = Object.freeze([
  // Stripe: the iframes of Stripe Elements and of the embedded Checkout, the hosted page of Stripe Checkout, and the
  // hosted page of a Payment Link (buy.stripe.com: its card fields are in its main frame); its API, its fraud frame and
  // the origin that this frame posts to (m.stripe.com), its 3-D Secure frames. Board ab-sta.13 looked at Stripe's public
  // test pages from the Linux server (no card typed): it added buy.stripe.com and m.stripe.com; the pages' other origins
  // carry no payment (r.stripe.com and errors.stripe.com: telemetry and error reports; merchant-ui-api.stripe.com and
  // checkout-cookies.stripe.com: Link's and Checkout's cookies; b.stripecdn.com and img.stripecdn.com: a captcha's, a
  // map's and the wallets' frames, images), and the act's rules block them.
  { name: "stripe", frames: ["https://js.stripe.com", "https://checkout.stripe.com", "https://buy.stripe.com"], api: ["https://api.stripe.com", "https://m.stripe.network", "https://hooks.stripe.com", "https://m.stripe.com"] },
  // Braintree: Hosted Fields; its client API, its GraphQL API, its analytics.
  { name: "braintree", frames: ["https://assets.braintreegateway.com"], api: ["https://api.braintreegateway.com", "https://payments.braintree-api.com", "https://client-analytics.braintreegateway.com"] },
  // Square: the Web Payments SDK's card iframe; its tokenizer.
  { name: "square", frames: ["https://web.squarecdn.com"], api: ["https://pci-connect.squareup.com", "https://connect.squareup.com"] },
  // Adyen: the secured fields on the live regions' checkoutshopper hosts, which also take the fields' calls.
  { name: "adyen", frames: ["https://checkoutshopper-live.adyen.com", "https://checkoutshopper-live-us.adyen.com", "https://checkoutshopper-live-au.adyen.com", "https://checkoutshopper-live-apse.adyen.com", "https://checkoutshopper-live-in.adyen.com"], api: [] },
  // Shopify: the card fields of Shopify's checkout; its card vault.
  { name: "shopify", frames: ["https://checkout.pci.shopifyinc.com"], api: ["https://deposit.shopifycs.com", "https://deposit.us.shopifycs.com"] },
  // Authorize.net: the Accept Hosted payment form (its own origin takes its calls); Accept.js's API.
  { name: "authorize.net", frames: ["https://accept.authorize.net"], api: ["https://api2.authorize.net"] },
  // Cybersource: the Flex Microform fields (their own origin takes the token's call).
  { name: "cybersource", frames: ["https://flex.cybersource.com"], api: [] },
  // Spreedly: the iFrame payment fields (their own origin takes the token's call).
  { name: "spreedly", frames: ["https://core.spreedly.com"], api: [] },
  // PayPal: the card fields (their own origin takes their calls).
  { name: "paypal", frames: ["https://www.paypal.com"], api: [] },
].map((p) => Object.freeze({ ...p, frames: Object.freeze([...p.frames]), api: Object.freeze([...p.api]) })));

/** The hosted card fields' and hosted payment pages' origins of the first build (each provider's `frames`). */
export const PROVIDER_ORIGINS: readonly string[] = Object.freeze(PROVIDERS.flatMap((p) => p.frames));

/**
 * True when `origin` is a payment provider's frame or hosted page origin: on PROVIDER_ORIGINS, or on `extra` (the tests'
 * option only). The compare is of whole origins as the WHATWG URL parser gives them, so `https://js.stripe.com.example` or
 * a path is none. A provider's API origin is no frame's origin.
 */
export function isProviderOrigin(origin: string, extra: readonly string[] = []): boolean {
  if (typeof origin !== "string" || !URL.canParse(origin) || new URL(origin).origin !== origin) return false;
  return PROVIDER_ORIGINS.includes(origin) || extra.includes(origin);
}

/**
 * The provider whose card-field frame or hosted page has `origin`: a provider of PROVIDERS, or the tests' provider (its
 * frames `extra` and its API origins `extraApi`, the tests' options only); null for none.
 */
export function providerOf(origin: string, extra: readonly string[] = [], extraApi: readonly string[] = []): Provider | null {
  if (!isProviderOrigin(origin, extra)) return null;
  return PROVIDERS.find((p) => p.frames.includes(origin)) ?? { name: "test", frames: [...extra], api: [...extraApi] };
}

/** A provider's origins that the act's rules and the guard take: its frames' origins, then its API origins. */
export const providerHosts = (p: Provider): string[] => [...p.frames, ...p.api.filter((o) => !p.frames.includes(o))];
