// lib/timing.js — where the time of one Telegram update goes.
//
// One console line per update, prefixed "[tg-timing]", holding one JSON object.
// It exists to answer "why did that tap take two seconds": how long the whole
// handler ran, when the callback was answered, and how long each database and
// Telegram call took and when it started (so calls that ran side by side are
// visible as overlapping).
//
// What a line may contain: fixed names chosen in the code (the handler and the
// step labels), a boolean, the Vercel region, and numbers of milliseconds.
// What it must never contain: a token, a chat id, a name, a phone number, any
// lead data, a lead id, message text or callback data. Nothing here ever sees
// those values: a step is described by its label alone, and the arguments and
// the result of the wrapped call are passed through untouched and unread.
//
// Always on. The cost is two clock reads per step and one console.log per
// update.

import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

export const TIMING_PREFIX = '[tg-timing]';

/** True until this instance has handled its first update. Module level on
 *  purpose: a fresh instance (a cold start) loads this module again. */
let coldStart = true;

const store = new AsyncLocalStorage();

/** Names are code constants; this is the belt to those braces. Anything that
 *  is not a short lowercase identifier is replaced, so a value can never ride
 *  into the log through a label. */
const NAME = /^[a-z][a-z0-9_.]{0,47}$/;
const safeName = (s) => (typeof s === 'string' && NAME.test(s) ? s : 'invalid');

/** Bounds one line, whatever a handler does: steps past this are only counted. */
const MAX_STEPS = 40;

const ms = (n) => Math.max(0, Math.round(n));

/** Name the handler for the update being processed. Fixed strings only. */
export function setHandler(name) {
  const ctx = store.getStore();
  if (ctx) ctx.handler = safeName(name);
}

/**
 * Wrap an async function so each call is recorded as one step of the current
 * update: its label, when it started and how long it took. Outside an update
 * (a script, a test calling a helper directly) the function runs unwrapped.
 * The call's arguments, result and error are never inspected.
 */
export function timed(label, fn) {
  const name = safeName(label);
  return function timedStep(...args) {
    const ctx = store.getStore();
    if (!ctx) return fn.apply(this, args);
    const started = performance.now();
    const done = (failed) => {
      if (ctx.steps.length >= MAX_STEPS) { ctx.dropped++; return; }
      const step = { s: name, at: ms(started - ctx.t0), ms: ms(performance.now() - started) };
      if (failed) step.err = true;
      ctx.steps.push(step);
    };
    let out;
    try { out = fn.apply(this, args); } catch (e) { done(true); throw e; }
    if (!out || typeof out.then !== 'function') { done(false); return out; }
    return out.then((v) => { done(false); return v; }, (e) => { done(true); throw e; });
  };
}

/** Wrap every function named in `labels` ({ exportName: 'step.label' }). A
 *  name the module does not export fails at import time, not at the first tap. */
export function timedAll(mod, labels) {
  const out = {};
  for (const [key, label] of Object.entries(labels)) {
    if (typeof mod[key] !== 'function') throw new Error('timing_unknown_function');
    out[key] = timed(label, mod[key]);
  }
  return out;
}

/** The JSON object for one update. Exported so a test can check its shape. */
export function summarize(ctx, nowMs = performance.now()) {
  const steps = ctx.steps.slice().sort((a, b) => a.at - b.at);
  const of = (prefix) => steps.filter((x) => x.s.startsWith(prefix));
  const sum = (list) => list.reduce((n, x) => n + x.ms, 0);
  const answer = steps.find((x) => x.s === 'tg.answer_callback');
  const out = {
    v: 1,
    handler: ctx.handler,
    type: ctx.type,
    cold: ctx.cold,
  };
  const region = process.env.VERCEL_REGION;
  if (typeof region === 'string' && /^[a-z0-9-]{2,16}$/.test(region)) out.region = region;
  out.total_ms = ms(nowMs - ctx.t0);
  // When answerCallbackQuery was SENT (the spinner stops one Telegram round
  // trip later: answer_done_ms). Both null for a command.
  out.answer_ms = answer ? answer.at : null;
  out.answer_done_ms = answer ? answer.at + answer.ms : null;
  out.db_calls = of('db.').length;
  out.tg_calls = of('tg.').length;
  // Sums of the individual calls. Calls that overlap are counted in full, so
  // a sum can be larger than total_ms; the saving is the difference.
  out.db_sum_ms = sum(of('db.'));
  out.tg_sum_ms = sum(of('tg.'));
  out.steps = steps;
  if (ctx.dropped) out.steps_dropped = ctx.dropped;
  return out;
}

/**
 * Run one update under a timing context and print its line when it is over,
 * whether it returned or threw. `type` is 'message', 'callback' or 'member'.
 * A failure to print never reaches the caller.
 */
export async function runTimed(type, fn) {
  const ctx = {
    t0: performance.now(), type: safeName(type), handler: 'unknown',
    cold: coldStart, steps: [], dropped: 0,
  };
  coldStart = false;
  try {
    return await store.run(ctx, fn);
  } finally {
    try { console.log(`${TIMING_PREFIX} ${JSON.stringify(summarize(ctx))}`); } catch { /* never fatal */ }
  }
}
