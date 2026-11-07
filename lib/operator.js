// lib/operator.js — who the operator is, and the one rule for talking to them.
//
// The operator is the person who runs the platform, not a client. There is
// exactly one operator chat: OPERATOR_CHAT_ID, falling back to TELEGRAM_CHAT_ID
// (the older single-tenant variable, kept so an existing deployment keeps
// working without a new value). OPERATOR_EMAIL is the email fallback.
//
// Operator-only content is: the mail-redirect warning, aggregate numbers,
// business names or slugs, and "no phone connected" notices. None of it may
// reach a business_chats recipient, whatever that business's status is. A demo
// business is the operator's own test row, but its bound chats are still chats
// that could be handed to a client tomorrow — so "demo" is not an audience.

/** The operator chat id as a string, or null. */
export function operatorChatId() {
  const v = process.env.OPERATOR_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  return v ? String(v).trim() : null;
}

export function operatorEmail() {
  const v = String(process.env.OPERATOR_EMAIL || '').trim();
  return v || null;
}

/** True only for a private chat whose id is the operator's. */
export function isOperatorChat(chatId, chatType) {
  const op = operatorChatId();
  if (!op || !chatId) return false;
  if (chatType !== undefined && chatType !== null && chatType !== 'private') return false;
  return String(chatId) === op;
}

/** Can an operator message be delivered at all? Used by /api/health. */
export function operatorReachable() {
  return !!(operatorChatId() || operatorEmail());
}
