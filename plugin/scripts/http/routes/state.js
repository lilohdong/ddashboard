// GET /api/state (read-only: gone sessions are ended by the server's liveness tick) and GET /api/search.
const cards = require('../../app/cards');
const serverState = require('../../app/server-state');

module.exports = [
  {
    method: 'GET', path: '/api/state', sameOrigin: false, body: false,
    handler: ({ url }) => serverState.build({ reports: url.searchParams.get('reports') === '1' }),
  },
  {
    method: 'GET', path: '/api/search', sameOrigin: false, body: false,
    handler: ({ url }) => {
      const q = url.searchParams;
      const mode = ['include', 'only', 'exclude'].includes(q.get('archived')) ? q.get('archived') : 'include';
      const limit = Math.min(Math.max(Number(q.get('limit')) || 100, 1), 500);
      const filter = { key: q.get('key') || '', project_key: q.get('project_key') || '' };
      return { cards: cards.search(q.get('q') || '', mode, limit, filter) };
    },
  },
];
