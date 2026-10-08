export type E164 = `+${string}`;
export type SmsFrom = E164 | { senderId: string } | { shortCode: string } | { messagingService: string };
export type Delivery = "unknown" | "queued" | "sent" | "delivered" | "undelivered" | "filtered";
export type SmsCapabilities = { sendText: true; mms: boolean; scheduling: boolean; inbound: boolean; deliveryReceipts: boolean; senderTypes: Array<"long_code"|"toll_free"|"short_code"|"alphanumeric"|"messaging_service">; partial?: boolean; reason?: string };
export type SmsSendInput = { to: E164; from?: SmsFrom; body: string; idempotencyKey?: string; mediaUrls?: string[]; sendAt?: Date; validityPeriodSec?: number; webhookUrl?: string };
export type SendContext = { signal?: AbortSignal; attempt: number; idempotencyKey?: string };
export type AdapterRejection = { kind: "rejected"; message: string; eligibleForFallback: boolean; rateLimited?: boolean; retryAfter?: number; status?: number; code?: string };
export type AdapterSendOutcome = { kind: "accepted"; providerId?: string; delivery?: Delivery; raw?: unknown } | AdapterRejection | { kind: "unknown"; message: string; cause?: unknown; status?: number };
export interface SmsAdapter { readonly name: string; readonly capabilities: SmsCapabilities; readonly defaultFrom?: SmsFrom; send(input: SmsSendInput, context: SendContext): Promise<AdapterSendOutcome>; }
export type SmsSendResult = { id: string; provider: string; providerId?: string; handoff: "accepted"; delivery: Delivery; encoding: "gsm7"|"ucs2"; segments: number; attemptedProviders: string[] };
export type SmsValidationIssue = { code: string; message: string; field?: string };
export type SmsValidationResult = { supported: boolean; encoding: "gsm7"|"ucs2"; segments: number; septets?: number; codeUnits?: number; containsUnicode: boolean; issues: SmsValidationIssue[]; adapterCandidates: string[] };
export type SmsHooks = { onAttempt?: (event: { provider:string; attempt:number; input: SmsSendInput }) => void|Promise<void>; onAccepted?: (event: SmsSendResult) => void|Promise<void>; onFailure?: (event: { provider:string; error: unknown }) => void|Promise<void> };
export interface IdempotencyRecord { fingerprint:string; state:"reserved"|"accepted"|"rejected"|"unknown"; reservationId?:string; result?:SmsSendResult; error?:unknown; expiresAt:number; }
export interface IdempotencyStore { get(key:string):Promise<IdempotencyRecord|null>; reserve(key:string,fingerprint:string,ttlSec:number):Promise<{kind:"reserved";reservationId:string}|{kind:"existing";record:IdempotencyRecord}|{kind:"conflict"}>; finalize(key:string,reservationId:string,result:IdempotencyRecord):Promise<void>; }
export type SmsClientOptions = { adapters: readonly SmsAdapter[]; fallback?: "on-known-rejection"; idempotencyStore?: IdempotencyStore; idempotencyTtlSec?: number; hooks?: SmsHooks; beforeSend?: (input:SmsSendInput)=>void|Promise<void> };
export type SmsClient = { send(input:SmsSendInput, options?:{signal?:AbortSignal}):Promise<SmsSendResult>; validate(input:SmsSendInput):SmsValidationResult; capabilities():ReadonlyArray<{name:string;capabilities:SmsCapabilities}> };
