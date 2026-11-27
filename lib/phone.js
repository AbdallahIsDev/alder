/* One phone rule, used on both sides of the form.
 *
 * The block between the markers is copied, with `export ` removed, into
 * index.html. tests/phone.test.mjs PH6 fails if the two ever drift, so the
 * browser validator cannot disagree with the server one without a red test.
 *
 * NANP shapes (the default US business, or an explicit +1) are checked here,
 * including the 555 range that libphonenumber-js marks as fictional. Every
 * other calling code is handed to a caller-supplied strict validator: the
 * server passes libphonenumber-js/max, the browser passes the PHONE_CC table
 * baked by build-static.js. Normalisation always happens here, first.
 */

/*__PHONE_RULE_START__*/
export var AR = '\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669';
export var FA = '\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9';

export function ascii(s) {
  return String(s == null ? '' : s).replace(/[\u0660-\u0669\u06F0-\u06F9]/g, function (c) {
    var i = AR.indexOf(c);
    return i > -1 ? String(i) : String(FA.indexOf(c));
  });
}

export function phoneConfig(table, defaultCc) {
  return { table: table || null, defaultCc: String(defaultCc || '1') };
}

export function matchCc(digits, table) {
  if (!table) return null;
  for (var l = 3; l >= 1; l--) {
    var cc = String(digits).slice(0, l);
    if (Object.prototype.hasOwnProperty.call(table, cc)) return cc;
  }
  return null;
}

/* Display-only normalisation. Keeps the punctuation the visitor typed and
   every letter, so a bad character is shown in the field and refused by
   normalizePhone instead of being silently swallowed. */
export function sanitizePhone(raw, cfg) {
  var v = ascii(raw == null ? '' : String(raw));
  if (v.slice(0, 2) === '00') v = '+' + v.slice(2);
  var out = '';
  for (var i = 0; i < v.length; i++) {
    var ch = v.charAt(i);
    if (ch === '+' && i === 0) { out = '+'; continue; }
    if ((ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')
      || ch === ' ' || ch === '(' || ch === ')' || ch === '.' || ch === '-' || ch === '/'
      || (ch >= '\u2010' && ch <= '\u2015')) out += ch;
  }
  return out;
}

function result(ok, value, reason) {
  return { ok: ok, value: value === undefined ? null : value, reason: reason || null };
}

/* The single validator. `cfg` = phoneConfig(table, defaultCc). `strict` is
   optional and is called only for non-NANP numbers, with the normalised text. */
export function normalizePhone(raw, cfg, strict) {
  var v = sanitizePhone(raw, cfg).trim();
  if (!v) return result(false, null, 'empty');
  if (/[A-Za-z]/.test(v)) return result(false, null, 'letters');
  if (/[^\d+\s().\-\/\u2010-\u2015]/.test(v)) return result(false, null, 'characters');
  var digits = v.replace(/\D/g, '');
  if (!digits) return result(false, null, 'empty');
  var plus = v.charAt(0) === '+';
  var cc = plus && cfg ? matchCc(digits, cfg.table) : null;
  var localCc = cfg ? cfg.defaultCc : '1';
  var nanp = (!plus && localCc === '1') || cc === '1' || (plus && !cc && digits.charAt(0) === '1');

  if (nanp) {
    var national = digits;
    if (national.length === 11 && national.charAt(0) === '1') national = national.slice(1);
    if (national.length < 10) return result(false, null, 'too-short');
    if (national.length > 10) return result(false, null, 'too-long');
    var area = national.slice(0, 3);
    if (area.charAt(0) === '0' || area.charAt(0) === '1') return result(false, null, 'area-code');
    return result(true, '+1' + national);
  }

  if (typeof strict === 'function') {
    var e164 = strict(v);
    return e164 ? result(true, e164) : result(false, null, 'number');
  }
  if (!cc || !cfg || !cfg.table) return result(false, null, 'country-code');
  var range = cfg.table[cc];
  var nat = digits.slice(cc.length);
  if (nat.length > range[1] && nat.charAt(0) === '0') nat = nat.slice(1);
  if (nat.length < range[0] || nat.length > range[1]) return result(false, null, 'number');
  return result(true, '+' + cc + nat);
}
/*__PHONE_RULE_END__*/
