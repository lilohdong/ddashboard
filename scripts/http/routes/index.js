// The server's route table: static files first, then one module per resource.
module.exports = [
  ...require('./static'),
  ...require('./settings'),
  ...require('./state'),
  ...require('./cards'),
  ...require('./mode'),
  ...require('./sessions'),
  ...require('./team'),
  ...require('./groups'),
  ...require('./reply'),
];
