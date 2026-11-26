// Ids for cards, inbox messages and replies: time-ordered, short, unique enough for one board.
const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

module.exports = { newId };
