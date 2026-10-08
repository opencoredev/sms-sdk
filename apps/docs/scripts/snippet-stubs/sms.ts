// Stand-in for the reader's `sms.ts` module in doc snippets: a configured
// client. The real one is shown on the quick start page.
import { createSmsClient } from "@opencoredev/sms-sdk";
import { memory } from "@opencoredev/sms-sdk/testing";

export const sms = createSmsClient({ adapters: [memory()] });
