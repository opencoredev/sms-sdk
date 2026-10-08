# @opencoredev/sms-sdk

A zero-runtime-dependency TypeScript SMS transport SDK for Twilio, Telnyx, Plivo, and Vonage.

```ts
import { createSmsClient } from "@opencoredev/sms-sdk";
import { twilio } from "@opencoredev/sms-sdk/twilio";
const sms=createSmsClient({adapters:[twilio({accountSid,authToken,from})]});
const result=await sms.send({to:"+14155550123",body:"Your order shipped",idempotencyKey:"order:123"});
```

`send()` resolves only after provider handoff is accepted. Timeouts and malformed success responses throw `HandoffUnknownError` and are never retried or failed over. Segment counts are estimates based on GSM-7 or UCS-2; they are not billing quotes. `validate()` is synchronous and never performs network I/O.

Provider setup, webhook verification, and current endpoint evidence are in `PROVIDERS.md`. The memory adapter is available from `@opencoredev/sms-sdk/testing`.
