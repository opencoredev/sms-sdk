import { describe, test } from "bun:test";
import { sinch } from "../../src/providers/sinch.js";
import { smsAdapterContractCases } from "../../src/testing/contracts.js";

const message = { to: "+15551234567", from: { kind: "phone_number", value: "+15557654321" }, body: "hello", mediaUrls: [] } as const;
const cases = smsAdapterContractCases(
  (fetch) => sinch({ servicePlanId: "plan", apiToken: "token", fetch }),
  {
    message,
    request: { url: "https://sms.api.sinch.com/xms/v1/plan/batches", headers: { Authorization: "Bearer token", "Content-Type": "application/json" }, body: { kind: "json", value: { from: "+15557654321", to: ["+15551234567"], body: "hello" } } },
    accepted: { response: { status: 202, body: { id: "batch-1" } }, providerId: "batch-1", delivery: "queued" },
    permanentRejection: { response: { status: 400, body: { code: "40001", text: "invalid request" } }, category: "request" },
    eligibleRejection: { response: { status: 401, body: { code: "401", text: "unauthorized" } }, category: "auth" },
    rateLimited: { response: { status: 429, body: { code: "429", text: "rate limited" }, headers: { "retry-after": "2" } }, retryAfterMs: 2000 },
    malformedSuccess: { status: 202, body: {} },
    serverError: { status: 503, body: { code: "503", text: "unavailable" } },
  },
);

describe("Sinch adapter contract", () => {
  for (const contract of cases) test(contract.name, contract.run);
});
