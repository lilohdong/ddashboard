// POST /api/archive {card_id, archived} -> archive or unarchive a card.
const cards = require('../../cards');
const { fail } = require('../router');

module.exports = [
  {
    method: 'POST', path: '/api/archive', sameOrigin: true, body: true,
    handler: ({ body: msg }) => {
      const id = String(msg.card_id || '');
      if (!id) throw fail(400, 'card_id required');
      if (typeof msg.archived !== 'boolean') throw fail(400, 'archived must be true or false');
      if (!cards.exists(id)) throw fail(404, 'unknown card', 'unknown_card');
      cards.setArchived(id, msg.archived);
      return { ok: true };
    },
  },
];
