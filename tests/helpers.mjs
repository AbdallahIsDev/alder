// tests/helpers.mjs — shared test scaffolding.
//
// Two things used to be copy-pasted into four suites each:
//   fakeRes()   the minimal Vercel response object the in-process handler calls write to
//   'alder-demo' the slug every suite resolves to a business row
//
// Keeping one copy means a change to the stub, or to the seed slug, happens once.
// (A dedicated test business, seeded by the suite itself, is still the better answer;
// that is what the fixture work replaces this constant with.)

/** The seed business every suite resolves through. */
export const ALDER_DEMO = 'alder-demo';

/**
 * Minimal response object: setHeader/status/json/send/end, recording the last body.
 * `body` starts as null unless a suite needs '' (review's page reads it as text).
 */
export function fakeRes({ body = null } = {}) {
  return {
    code: 0,
    body,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
    send(s) { this.body = s; return this; },
    end() { return this; },
  };
}
