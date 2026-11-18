'use strict';

const { processNormalizedBatch, processSyntheticBatch } = require('./pipeline-adapter.cjs');

module.exports = {
  processNormalizedBatch,
  processSyntheticBatch,
  ...require('./versioned-pipeline.cjs'),
  ...require('./notification-policy-v2.cjs'),
  ...require('./tagging.cjs'),
  ...require('./effective-configuration.cjs'),
  ...require('./versioned-persistence.cjs'),
  ...require('./gmail-live.cjs'),
  ...require('./live-persistence.cjs'),
  ...require('./n8n-persistence.cjs'),
  ...require('./historical-ingestion.cjs'),
};
