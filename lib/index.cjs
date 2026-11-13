'use strict';

const { processSyntheticBatch } = require('./pipeline-adapter.cjs');

module.exports = {
  processSyntheticBatch,
  ...require('./gmail-live.cjs'),
};
