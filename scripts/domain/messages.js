// Inbox messages as text for the session that receives them: dashboard replies, member reports, lead orders.
const REPORT_DETAILS_MAX = 300;

// A member's card as a report message for the lead. Long details stay on the card (read with team.js show).
function reportMessage(card, s) {
  const msg = {
    type: 'report', from: s.session_id, role: s.role || 'member', card_id: card.id,
    status: card.status, title: card.title, summary: card.summary || [], review: card.review || [],
  };
  if (card.details) {
    if (card.details.length > REPORT_DETAILS_MAX) msg.details_ref = card.id;
    else msg.details = card.details;
  }
  return msg;
}

function formatReplies(msgs) {
  return msgs.map((m) => `- ${m.card_title ? `[card: ${m.card_title}] ` : ''}${m.text}`).join('\n');
}

function formatReports(msgs) {
  return msgs.map((m) => {
    const lines = [`- ${m.role || 'member'} (${String(m.from || '').slice(0, 8)}) ${m.status || 'done'}: ${m.title || ''}`];
    for (const x of [].concat(m.summary || [])) lines.push(`  ${x}`);
    for (const x of [].concat(m.review || [])) lines.push(`  check: ${x}`);
    if (m.details) lines.push(`  details: ${m.details}`);
    if (m.details_ref) lines.push(`  details: long, read with: team.js show ${m.details_ref}`);
    return lines.join('\n');
  }).join('\n');
}

const formatOrders = (msgs) => msgs.map((m) => `- ${m.text}`).join('\n');

const HEADERS = { reply: '[Dashboard reply]', report: '[Team report]', order: '[Lead instruction]' };

// Inbox messages grouped by type, each group under its header. Untyped messages are dashboard replies.
function formatMessages(msgs) {
  const by = { reply: [], report: [], order: [] };
  for (const m of msgs) (by[m.type] || by.reply).push(m);
  const out = [];
  if (by.reply.length) out.push(`${HEADERS.reply}\n${formatReplies(by.reply)}`);
  if (by.report.length) out.push(`${HEADERS.report}\n${formatReports(by.report)}`);
  if (by.order.length) out.push(`${HEADERS.order}\n${formatOrders(by.order)}`);
  return out.join('\n\n');
}

// Wake reason for a batch of handed-over messages (dashboard replies win).
function messagesReason(msgs) {
  const types = new Set(msgs.map((m) => m.type || 'reply'));
  return types.has('reply') ? 'reply' : types.has('report') ? 'report' : 'order';
}

module.exports = { REPORT_DETAILS_MAX, reportMessage, formatReplies, formatReports, formatOrders, formatMessages, messagesReason };
