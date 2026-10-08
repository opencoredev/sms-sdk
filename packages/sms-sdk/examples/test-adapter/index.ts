/**
 * Test SMS code without a network or a provider account.
 *   bun examples/test-adapter/index.ts
 */
import { fileURLToPath } from "node:url";
import { createSmsClient, ProviderRejectedError, type SmsClient } from "@opencoredev/sms-sdk";
import { memory, rejectedOutcome } from "@opencoredev/sms-sdk/testing";

/** Application code under test: it only knows about the SmsClient interface. */
export async function sendLoginCode(sms: SmsClient, to: `+${string}`, code: string): Promise<string> {
  const result = await sms.send({ to, body: `Your login code is ${code}`, idempotencyKey: `login:${to}:${code}` });
  return result.providerId;
}

export async function run(): Promise<{ sentBodies: string[]; rejectedCategory: string | undefined }> {
  const adapter = memory();
  const sms = createSmsClient({ adapters: [adapter] });
  await sendLoginCode(sms, "+14155550123", "482913");

  // Script the next outcome to test error handling.
  adapter.enqueue(rejectedOutcome("compliance", { code: "21610" }));
  let rejectedCategory: string | undefined;
  try {
    await sendLoginCode(sms, "+14155550124", "111222");
  } catch (error) {
    if (error instanceof ProviderRejectedError) {
      rejectedCategory = error.category;
    }
  }

  return { sentBodies: adapter.sent.map((sent) => sent.message.body), rejectedCategory };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { sentBodies, rejectedCategory } = await run();
  console.log(`Recorded ${sentBodies.length} sends; second was rejected as ${rejectedCategory ?? "nothing"}.`);
}
