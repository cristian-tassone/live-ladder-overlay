'use strict';

const record2020 = require('./record2020');
const scorebug = require('./scorebug');
const manual = require('./manual');
const demo = require('./demo');

const adapters = { record2020, scorebug, manual, test: demo, demo };

/** Guess the source type from a pasted URL so the operator rarely has to pick. */
function detectType(url) {
  if (record2020.canHandle(url)) return 'record2020';
  if (scorebug.canHandle(url)) return 'scorebug';
  return null;
}

function get(type) {
  return adapters[type] || null;
}

/** Types the operator can choose in SOURCE. */
function list() {
  return [record2020, scorebug, demo].map((a) => ({
    id: a.id,
    label: a.label,
    placeholder: a.placeholder
  }));
}

module.exports = { adapters, get, list, detectType };
