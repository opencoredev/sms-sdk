import { createSmsClient } from "@opencoredev/sms-sdk"; import { twilio } from "@opencoredev/sms-sdk/twilio";
const sms=createSmsClient({adapters:[twilio({accountSid:process.env.TWILIO_ACCOUNT_SID!,authToken:process.env.TWILIO_AUTH_TOKEN!,from:process.env.TWILIO_FROM})]});
await sms.send({to:"+14155550123",body:"Hello from SMS SDK"});
