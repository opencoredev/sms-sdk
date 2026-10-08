/**
 * Test helpers: an in-memory adapter, a recording fake `fetch`, signed
 * webhook request builders, and the adapter contract harness.
 *
 * Nothing here sends real messages.
 *
 * @packageDocumentation
 */

export {
  acceptedOutcome,
  memory,
  rejectedOutcome,
  unknownOutcome,
  type MemoryAdapter,
  type MemoryAdapterOptions,
  type MemoryOutcome,
  type MemorySentMessage,
} from "./memory.js";
export {
  mockFetch,
  type MockFetch,
  type MockReply,
  type MockResponse,
  type RecordedRequest,
} from "./fetch.js";
export {
  generateTelnyxKeyPair,
  signedPlivoRequest,
  signedTelnyxRequest,
  signedTwilioRequest,
  signedVonageRequest,
} from "./webhooks.js";
export {
  runSmsAdapterContract,
  smsAdapterContractCases,
  type AdapterContractFixtures,
  type AdapterFactory,
  type ContractCase,
  type ContractReport,
  type ExpectedBody,
  type WebhookContractCase,
} from "./contracts.js";
export { memoryIdempotencyStore } from "../core/idempotency.js";
