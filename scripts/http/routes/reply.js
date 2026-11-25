// POST /api/reply {session_id, text, card_id?, card_title?} -> saved to that session's inbox and the reply log.
const { readJson } = require('../../core/fsx');
const { paths, safeId } = require('../../core/paths');
const { deliver } = require('../../store/inbox');
const replies = require('../../store/replies');
const { newId } = require('../../core/ids');
const { fail } = require('../router');

module.exports = [
  {
    method: 'POST', path: '/api/reply', sameOrigin: true, body: true,
    handler: ({ body: msg }) => {
      const sid = safeId(msg.session_id);
      const text = String(msg.text || '').trim();
      if (!text) throw fail(400, 'empty', 'empty');
      const sessions = readJson(paths.sessions, {});
      if (!sessions[sid]) throw fail(404, 'unknown session', 'unknown_session');
      if (sessions[sid].ended || sessions[sid].state === 'ended') throw fail(409, 'session ended', 'session_ended');
      const reply = deliver(sid, {
        type: 'reply',
        id: newId(),
        ts: new Date().toISOString(),
        card_id: msg.card_id ? String(msg.card_id) : null,
        card_title: msg.card_title ? String(msg.card_title).slice(0, 200) : null,
        text: text.slice(0, 4000),
      });
      replies.append(reply);
      return { ok: true, id: reply.id };
    },
  },
];
