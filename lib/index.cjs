'use strict';

const { processSyntheticBatch } = require('./pipeline-adapter.cjs');

module.exports = {
  processSyntheticBatch,
  ...require('./gmail-live.cjs'),
  ...require('./live-persistence.cjs'),
  ...require('./n8n-persistence.cjs'),
};
