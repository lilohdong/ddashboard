// Team members: registration from the first-prompt tag.
const config = require('../core/config');
const sessionsStore = require('../store/sessions');

// Register a session as a member (from its tag). The session must be registered already.
function setMember(sid, tag) {
  return sessionsStore.patch(sid, {
    kind: 'member', role: tag.role, lead: tag.lead, stay: Boolean(tag.stay), pending: undefined,
    ...(tag.group ? { group: tag.group } : {}),
    ...(config.get('DDASH_NAME') ? {} : { name: tag.role }),
  });
}

module.exports = { setMember };
