import { describe, expect, test } from "bun:test";
import { createSmsClient } from "../../src/core/client.js";
import {
  HandoffUnknownError,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  ProviderRejectedError,
} from "../../src/core/errors.js";
import { fingerprintMessage, memoryIdempotencyStore, type IdempotencyStore } from "../../src/core/idempotency.js";
import type { AdapterSendOutcome } from "../../src/core/adapters.js";
import { memory, rejectedOutcome, unknownOutcome } from "../../src/testing/memory.js";
import { rejection } from "../helpers.js";

/**
 * An outcome that resolves after a delay long enough for concurrent calls to
 * reach the client's in-flight check, even on a loaded machine.
 */
function slowAccept(providerId: string): () => Promise<AdapterSendOutcome> {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { kind: "accepted", providerId, delivery: "queued" };
  };
}

const message = { to: "+14155550123", body: "Appointment tomorrow at 9.", idempotencyKey: "appt:1:reminder" } as const;

describe("idempotent replay", () => {
  test("replays an accepted send without a second request", async () => {
    const adapter = memory();
    const sms = createSmsClient({ adapters: [adapter], idempotency: { store: memoryIdempotencyStore() } });
    const first = await sms.send(message);
    const second = await sms.send(message);
    expect(adapter.sent).toHaveLength(1);
    expect(second).toEqual({ ...first, replayed: true });
  });

  test("the same key with a different body conflicts", async () => {
    const adapter = memory();
    const sms = createSmsClient({ adapters: [adapter], idempotency: { store: memoryIdempotencyStore() } });
    await sms.send(message);
    const error = await rejection(sms.send({ ...message, body: "Different text" }));
    expect(error).toBeInstanceOf(IdempotencyConflictError);
    expect(error).toMatchObject({ code: "idempotency_conflict", idempotencyKey: "appt:1:reminder" });
    expect(adapter.sent).toHaveLength(1);
  });

  test("the same key with a different sender conflicts", async () => {
    const sms = createSmsClient({ adapters: [memory()], idempotency: { store: memoryIdempotencyStore() } });
    await sms.send(message);
    await expect(sms.send({ ...message, from: "+15005550009" })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  test("the same key with a different recipient conflicts", async () => {
    const sms = createSmsClient({ adapters: [memory()], idempotency: { store: memoryIdempotencyStore() } });
    await sms.send(message);
    await expect(sms.send({ ...message, to: "+14155550124" })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  test("concurrent sends in one client share a single request", async () => {
    const adapter = memory();
    const sms = createSmsClient({ adapters: [adapter], idempotency: { store: memoryIdempotencyStore() } });
    const results = await Promise.all([sms.send(message), sms.send(message), sms.send(message)]);
    expect(adapter.sent).toHaveLength(1);
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(2);
  });

  test("concurrent sends without a store still coalesce in-process", async () => {
    const adapter = memory({ outcomes: [slowAccept("p1")] });
    const sms = createSmsClient({ adapters: [adapter] });
    await Promise.all([sms.send(message), sms.send(message)]);
    expect(adapter.sent).toHaveLength(1);
  });

  test("a concurrent in-process send with a different payload conflicts", async () => {
    const sms = createSmsClient({ adapters: [memory({ outcomes: [slowAccept("p1")] })] });
    const settled = await Promise.allSettled([sms.send(message), sms.send({ ...message, body: "other" })]);
    // Whichever call claims the key first sends; the other conflicts.
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      settled.filter((result) => result.status === "rejected" && result.reason instanceof IdempotencyConflictError),
    ).toHaveLength(1);
  });

  test("two clients sharing a store send once; the other sees in-progress", async () => {
    const store = memoryIdempotencyStore();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = memory({
      name: "slow",
      outcomes: [
        async () => {
          await gate;
          return { kind: "accepted", providerId: "p1", delivery: "queued" };
        },
      ],
    });
    const other = memory({ name: "slow" });
    const workerA = createSmsClient({ adapters: [slow], idempotency: { store } });
    const workerB = createSmsClient({ adapters: [other], idempotency: { store } });

    const pendingA = workerA.send(message);
    // Wait until worker A holds the reservation, however long hashing takes.
    while ((await store.get(message.idempotencyKey)) === null) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const errorB = await rejection(workerB.send(message));
    release();
    await pendingA;

    expect(errorB).toBeInstanceOf(IdempotencyInProgressError);
    expect(errorB).toMatchObject({ retrySafe: true });
    expect(other.sent).toHaveLength(0);
    await expect(workerB.send(message)).resolves.toMatchObject({ providerId: "p1", replayed: true });
  });

  test("an unknown outcome replays as unknown and never resends", async () => {
    const store = memoryIdempotencyStore();
    const adapter = memory({ outcomes: [unknownOutcome("timeout")] });
    const sms = createSmsClient({ adapters: [adapter], idempotency: { store, ttlSec: 0 } });
    await expect(sms.send(message)).rejects.toBeInstanceOf(HandoffUnknownError);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const replay = await rejection(sms.send(message));
    expect(replay).toBeInstanceOf(HandoffUnknownError);
    expect(replay).toMatchObject({ reason: "replayed_unknown", retrySafe: false });
    expect(adapter.sent).toHaveLength(1);
  });

  test("a rejected send may be retried with the same key", async () => {
    const adapter = memory({ outcomes: [rejectedOutcome("sender")] });
    const sms = createSmsClient({ adapters: [adapter], idempotency: { store: memoryIdempotencyStore() } });
    await expect(sms.send(message)).rejects.toBeInstanceOf(ProviderRejectedError);
    await expect(sms.send(message)).resolves.toMatchObject({ handoff: "accepted", replayed: false });
    expect(adapter.sent).toHaveLength(2);
  });

  test("a stale reservation (crashed worker) is reported as unknown, not resent", async () => {
    const store = memoryIdempotencyStore();
    const fingerprint = await fingerprintMessage({
      to: message.to,
      from: null,
      body: message.body,
      mediaUrls: [],
      sendAt: null,
      validityPeriodSec: null,
      webhookUrl: null,
    });
    await store.reserve({ key: message.idempotencyKey, fingerprint, now: Date.now() - 600_000 });
    const adapter = memory();
    const sms = createSmsClient({ adapters: [adapter], idempotency: { store, staleReservationSec: 300 } });
    const error = await rejection(sms.send(message));
    expect(error).toBeInstanceOf(HandoffUnknownError);
    expect(error).toMatchObject({ reason: "stale_reservation" });
    expect(adapter.sent).toHaveLength(0);
  });

  test("a store failure after acceptance still returns the result", async () => {
    const inner = memoryIdempotencyStore();
    const store: IdempotencyStore = {
      get: (key) => inner.get(key),
      reserve: (input) => inner.reserve(input),
      finalize: async () => {
        throw new Error("store offline");
      },
    };
    const sms = createSmsClient({ adapters: [memory()], idempotency: { store } });
    await expect(sms.send(message)).resolves.toMatchObject({ handoff: "accepted" });
    await expect(sms.send(message)).rejects.toBeInstanceOf(IdempotencyInProgressError);
  });
});

describe("memoryIdempotencyStore contract", () => {
  test("reserve is exclusive", async () => {
    const store = memoryIdempotencyStore();
    const results = await Promise.all([
      store.reserve({ key: "k", fingerprint: "f", now: 1 }),
      store.reserve({ key: "k", fingerprint: "f", now: 1 }),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(["existing", "reserved"]);
  });

  test("finalize requires the owning reservation", async () => {
    const store = memoryIdempotencyStore();
    const now = Date.now();
    const reserved = await store.reserve({ key: "k", fingerprint: "f", now });
    if (reserved.kind !== "reserved") throw new Error("expected reservation");
    const error = { name: "x", code: "provider_rejected", message: "m", retrySafe: true, attempts: [] } as const;
    expect(await store.finalize({ key: "k", reservationId: "someone-else", record: { state: "rejected", fingerprint: "f", error }, ttlSec: 60, now })).toEqual({ kind: "not_owner" });
    expect(await store.finalize({ key: "k", reservationId: reserved.reservationId, record: { state: "rejected", fingerprint: "f", error }, ttlSec: 60, now })).toEqual({ kind: "finalized" });
    expect((await store.get("k"))?.state).toBe("rejected");
  });

  test("rejected records can be re-reserved only with the same fingerprint", async () => {
    const store = memoryIdempotencyStore();
    const reserved = await store.reserve({ key: "k", fingerprint: "f", now: 1 });
    if (reserved.kind !== "reserved") throw new Error("expected reservation");
    const error = { name: "x", code: "provider_rejected", message: "m", retrySafe: true, attempts: [] } as const;
    await store.finalize({ key: "k", reservationId: reserved.reservationId, record: { state: "rejected", fingerprint: "f", error }, ttlSec: 60, now: 2 });
    expect((await store.reserve({ key: "k", fingerprint: "other", now: 3 })).kind).toBe("existing");
    expect((await store.reserve({ key: "k", fingerprint: "f", now: 3 })).kind).toBe("reserved");
  });

  test("unknown records do not expire; delete clears them", async () => {
    const store = memoryIdempotencyStore();
    const reserved = await store.reserve({ key: "k", fingerprint: "f", now: 1 });
    if (reserved.kind !== "reserved") throw new Error("expected reservation");
    const error = { name: "x", code: "handoff_unknown", message: "m", retrySafe: false, attempts: [] } as const;
    await store.finalize({ key: "k", reservationId: reserved.reservationId, record: { state: "unknown", fingerprint: "f", error }, ttlSec: 0, now: 2 });
    expect((await store.reserve({ key: "k", fingerprint: "f", now: Date.now() + 10 ** 9 })).kind).toBe("existing");
    await store.delete("k");
    expect(store.size).toBe(0);
  });

  test("accepted records expire after ttlSec", async () => {
    const store = memoryIdempotencyStore();
    const reserved = await store.reserve({ key: "k", fingerprint: "f", now: 0 });
    if (reserved.kind !== "reserved") throw new Error("expected reservation");
    const result = { id: "sms_1", provider: "m", providerId: "p", handoff: "accepted", delivery: "queued", encoding: "gsm7", segments: 1, attemptedProviders: ["m"], attempts: [], replayed: false } as const;
    await store.finalize({ key: "k", reservationId: reserved.reservationId, record: { state: "accepted", fingerprint: "f", result }, ttlSec: 10, now: 0 });
    expect((await store.reserve({ key: "k", fingerprint: "f", now: 9_000 })).kind).toBe("existing");
    expect((await store.reserve({ key: "k", fingerprint: "f", now: 10_000 })).kind).toBe("reserved");
  });

  test("fingerprints are stable and sensitive to every field", async () => {
    const base = { to: "+1", from: null, body: "b", mediaUrls: [], sendAt: null, validityPeriodSec: null, webhookUrl: null };
    const reference = await fingerprintMessage(base);
    expect(await fingerprintMessage(base)).toBe(reference);
    expect(reference).toMatch(/^[0-9a-f]{64}$/);
    for (const change of [
      { to: "+2" },
      { from: "+3" },
      { body: "c" },
      { mediaUrls: ["https://x"] },
      { sendAt: "2030-01-01T00:00:00.000Z" },
      { validityPeriodSec: 60 },
      { webhookUrl: "https://y" },
    ]) {
      expect(await fingerprintMessage({ ...base, ...change })).not.toBe(reference);
    }
  });
});
