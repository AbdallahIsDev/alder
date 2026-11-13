// tests/fixture-ids.mjs — every chat id a suite may bind.
//
// WHY THE BASE: Telegram user ids are ~1e9 and group ids are ~-1e12. The old
// fixtures (770001, 880001, 900001) sat inside the real user-id space, so a
// production run could rebind a real person's chat and then delete it. Every
// fixture id here starts at 5e15, which is:
//   - far above any real Telegram user or group id,
//   - still below Number.MAX_SAFE_INTEGER (9.007e15), so JSON numbers, bigint
//     columns, String() comparisons and callback regexes all behave exactly,
//   - a range no real chat can occupy, so `tg_chat_id >= BASE` is a safe sweep.
//
// Ids are unique per suite and purpose: a cleanup that deletes one suite's id
// must never touch another suite's row.

export const FIXTURE_ID_BASE = 5_000_000_000_000_000;

/** Fixture id n. Kept as a function so every id is visibly derived from the base. */
export const fixtureId = (n) => FIXTURE_ID_BASE + n;

export const FIXTURE_CHATS = Object.freeze({
  notifyOwner: fixtureId(1),      // notify: the one bound phone
  notifySecond: fixtureId(2),     // notify: the second-phone ownership case
  notifyFan1: fixtureId(3),       // notify: extra phones for the parallel fan-out test
  notifyFan2: fixtureId(4),
  notifyFan3: fixtureId(5),
  notifyFan4: fixtureId(6),
  leadApiAlert: fixtureId(10),    // lead-api: delivery target
  webhookA: fixtureId(20),        // webhook: business A owner
  webhookB: fixtureId(21),        // webhook: business B owner
  webhookX: fixtureId(22),        // webhook: unbound chat
  webhookA2: fixtureId(23),       // webhook: second phone on A
  webhookA3: fixtureId(24),       // webhook: third phone on A, removed
  webhookOpA: fixtureId(25),      // webhook: operator fixture business, owner
  webhookOpB: fixtureId(26),      // webhook: operator fixture business, second
  webhookOperator: fixtureId(27), // webhook: the operator's own chat
  webhookBindA: fixtureId(28),    // webhook: redeems the first bind code
  webhookBindB: fixtureId(29),    // webhook: bound elsewhere, redeems nothing
  webhookBindX: fixtureId(30),    // webhook: pastes a code (unbound)
  webhookInvOwner: fixtureId(31), // webhook: owner of the invite throwaway
  webhookInvStaff: fixtureId(32), // webhook: staff phone on the invite throwaway
  recipientsA: fixtureId(40),      // recipients: in-memory store only
  recipientsA2: fixtureId(41),
  recipientsB: fixtureId(42),
  recipientsOffice: fixtureId(43),
  browserOwner: fixtureId(50),     // lead-browser: in-memory store only
  browserStaff: fixtureId(51),
  browserB: fixtureId(52),
  browserX: fixtureId(53),
  browserOperator: fixtureId(54),
});

export const ALL_FIXTURE_CHAT_IDS = Object.freeze(Object.values(FIXTURE_CHATS));

/** True only for an id in the reserved fixture range. */
export function isFixtureChatId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= FIXTURE_ID_BASE;
}
