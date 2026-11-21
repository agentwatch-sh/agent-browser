// The payment providers' published TEST card numbers: the ONE file of this repository that holds card numbers (the
// secure card checkout design, R4 and section 11; board ab-sta.5). Each one is a number of a provider's own testing
// documentation (Stripe, Braintree, Adyen): it charges no card and belongs to no person. No real card number is in this
// repository: the repository check (test/card-numbers.test.ts) fails on each other number of 13 to 19 digits with a
// valid check digit, and allows only these. The tests and the live check (the plan's Task 6, with the test merchant of
// test/fixtures/pay-merchant/) take their numbers from here.

/** The numbers that the tests and the live check use, by name. */
export const TEST_CARDS = {
  /** Stripe: a Visa that succeeds. */
  visa: "4242424242424242",
  /** Stripe: a Visa that the bank declines (generic decline). */
  visaDeclined: "4000000000000002",
  /** Stripe: a Mastercard that succeeds. */
  mastercard: "5555555555554444",
  /** Stripe: an American Express (15 digits) that succeeds. */
  amex: "378282246310005",
  /** Stripe: a Discover that succeeds. */
  discover: "6011111111111117",
  /** Stripe: a Visa whose bank asks for a second step (3-D Secure 2). */
  visaBankStep: "4000000000003220",
} as const;

/** Every published test number that the repository check allows (the ones above among them). */
export const PUBLISHED_TEST_NUMBERS: readonly string[] = Object.freeze([
  // Stripe: https://docs.stripe.com/testing
  "4242424242424242", "4000056655665556", "5555555555554444", "2223003122003222", "5200828282828210", "378282246310005",
  "371449635398431", "6011111111111117", "6011000990139424", "3056930009020004", "36227206271667", "3566002020360505",
  "6200000000000005", "4000000000000002", "4000000000009995", "4000000000009987", "4000000000000069", "4000000000000127",
  "4000000000000119", "4000002500003155", "4000000000003220", "4000008400001629",
  // Braintree: https://developer.paypal.com/braintree/docs/reference/general/testing
  "4111111111111111", "4000111111111115", "5105105105105100", "378734493671000", "4012888888881881",
  // Adyen: https://docs.adyen.com/development-resources/testing/test-card-numbers
  "4111111145551142", "5555341244441115", "370000000000002",
]);

/** A test card's other values (made up; a provider's test mode takes any future expiry, any security code and any postal code). */
export const TEST_CARD_VALUES = { holder: "Test Holder", expiry: "12/34", csc: "123", postal: "12345" } as const;
