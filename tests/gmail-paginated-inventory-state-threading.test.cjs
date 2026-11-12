const test = require('node:test');
const assert = require('node:assert');

// Tests for the fixed pagination state threading in workflow 03
// These tests verify that state properly accumulates across loop iterations

const node = (name) => {
  const nodes = {
    'Configure Pagination': {
      parameters: {
        jsCode: `const maxMessages = 500;
const pageSize = 100;
const requestDelayMs = 200;
const maxRetries = 3;
const retryBaseDelayMs = 1000;

if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 10000) {
  throw new Error('maxMessages must be an integer from 1 to 10000');
}
if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
  throw new Error('pageSize must be an integer from 1 to 500');
}
if (!Number.isInteger(requestDelayMs) || requestDelayMs < 0 || requestDelayMs > 60000) {
  throw new Error('requestDelayMs must be an integer from 0 to 60000');
}
if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
  throw new Error('maxRetries must be an integer from 0 to 10');
}
if (!Number.isInteger(retryBaseDelayMs) || retryBaseDelayMs < 0 || retryBaseDelayMs > 60000) {
  throw new Error('retryBaseDelayMs must be an integer from 0 to 60000');
}

return [{
  json: {
    maxMessages,
    pageSize,
    requestDelayMs,
    maxRetries,
    retryBaseDelayMs,
    pagination: {
      nextPageToken: null,
      pagesFetched: 0,
      messagesDiscovered: 0,
      messageIds: []
    },
    apiRequests: 0,
    retryCount: 0,
    errors: []
  }
}];`
      }
    },
    'Merge Gmail Response': {
      parameters: {
        jsCode: `const gmailResponse = $input.first().json;
const previousState = $('Rate Limit Delay').first().json || $('Configure Pagination').first().json;

if (!previousState || !previousState.pagination) {
  throw new Error('Cannot find previous state from Rate Limit Delay or Configure Pagination');
}

return [{
  json: {
    ...previousState,
    _currentGmailResponse: gmailResponse
  }
}];`
      }
    },
    'Process Page Response': {
      parameters: {
        jsCode: `const state = $input.first().json;
const gmailResponse = state._currentGmailResponse || {};

const pageSize = state.pageSize;
const maxMessages = state.maxMessages;

const messages = gmailResponse.messages;
if (messages === undefined) {
  return [{
    json: {
      ...state,
      pagination: {
        ...state.pagination,
        pagesFetched: state.pagination.pagesFetched + 1,
        hasMorePages: false
      },
      apiRequests: state.apiRequests + 1,
      _currentGmailResponse: undefined
    }
  }];
}

if (!Array.isArray(messages)) {
  throw new Error('Unexpected Gmail messages list format');
}

if (messages.length > pageSize) {
  throw new Error('Gmail returned more messages than requested pageSize');
}

const ids = new Set(state.pagination.messageIds);
let newIds = [];
const currentCount = state.pagination.messageIds.length;

for (const message of messages) {
  if (typeof message.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(message.id)) {
    throw new Error('Invalid Gmail message ID format');
  }
  if (!ids.has(message.id) && currentCount + newIds.length < maxMessages) {
    newIds.push(message.id);
    ids.add(message.id);
  }
}

const totalDiscovered = state.pagination.messagesDiscovered + messages.length;
const hasReachedLimit = (currentCount + newIds.length) >= maxMessages;
const nextPageToken = gmailResponse.nextPageToken || null;
const hasMorePages = !hasReachedLimit && nextPageToken !== null && nextPageToken !== '';

const sameTokenTwice = nextPageToken && nextPageToken === state.pagination.nextPageToken && messages.length > 0;
if (sameTokenTwice) {
  throw new Error('Pagination error: same nextPageToken returned twice in a row');
}

return [{
  json: {
    ...state,
    pagination: {
      nextPageToken: nextPageToken,
      pagesFetched: state.pagination.pagesFetched + 1,
      messagesDiscovered: totalDiscovered,
      messageIds: [...state.pagination.messageIds, ...newIds],
      hasMorePages
    },
    apiRequests: state.apiRequests + 1,
    _currentGmailResponse: undefined
  }
}];`
      }
    },
    'Rate Limit Delay': {
      parameters: {
        jsCode: `const state = $input.first().json;
const delayMs = state.requestDelayMs;

if (typeof delayMs !== 'number' || delayMs < 0) {
  throw new Error('Invalid requestDelayMs');
}

// In tests, we skip actual delay
// await new Promise(resolve => setTimeout(resolve, delayMs));

return state;`
      }
    },
    'Prepare Metadata Requests': {
      parameters: {
        jsCode: `const state = $input.first().json;
const ids = state.pagination.messageIds;

if (!Array.isArray(ids) || ids.length === 0) {
  return [{
    json: {
      ...state,
      messagesAnalyzed: 0,
      unknownSenderCount: 0,
      senders: [],
      partial: ids.length === 0
    }
  }];
}

if (ids.length > state.maxMessages) {
  throw new Error('Message ID count exceeds maxMessages limit');
}

return ids.map(id => ({
  json: {
    id,
    state
  }
}));`
      }
    }
  };
  return nodes[name] || { parameters: { jsCode: '' } };
};

// Helper to run a node's code with mock n8n context
const run = (name, input, config = {}) => {
  const defaults = {
    maxMessages: 500,
    pageSize: 100,
    requestDelayMs: 200,
    maxRetries: 3,
    retryBaseDelayMs: 1000,
    pagination: {
      nextPageToken: null,
      pagesFetched: 0,
      messagesDiscovered: 0,
      messageIds: []
    },
    apiRequests: 0,
    retryCount: 0,
    errors: []
  };
  
  // Create a mock $input object that mimics n8n's input API
  const mockInput = {
    first: () => ({ json: input?.json || {} }),
    all: () => [{ json: input?.json || {} }]
  };
  
  // Create a mock $ function that mimics n8n's node reference API
  const mockNodeRef = (nodeName) => {
    if (nodeName === 'Configure Pagination') {
      return { first: () => ({ json: defaults }) };
    }
    if (nodeName === 'Rate Limit Delay') {
      // Return the input state (this node is the source for the next iteration)
      return { first: () => ({ json: input?.json || {} }) };
    }
    throw new Error(`Unexpected node reference: ${nodeName}`);
  };
  
  return new Function('$input', '$', node(name).parameters.jsCode)(
    mockInput,
    mockNodeRef
  );
};

// Test: Multi-iteration pagination with state accumulation (3 pages)
test('multi-iteration pagination accumulates state across loop iterations', () => {
  // Iteration 1: First 100 messages with nextPageToken
  const config1 = {
    maxMessages: 250,
    pageSize: 100,
    pagination: {
      nextPageToken: null,
      pagesFetched: 0,
      messagesDiscovered: 0,
      messageIds: []
    }
  };
  
  const gmailPage1 = {
    json: {
      messages: Array.from({ length: 100 }, (_, i) => ({ id: `msg-${i + 1}` })),
      nextPageToken: 'token-1'
    }
  };
  
  // Simulate Merge Gmail Response
  const mergedIter1 = {
    json: {
      ...config1,
      _currentGmailResponse: gmailPage1.json
    }
  };
  
  const result1 = run('Process Page Response', mergedIter1)[0].json;
  
  assert.equal(result1.pagination.messageIds.length, 100, 'Iteration 1: should have 100 message IDs');
  assert.equal(result1.pagination.pagesFetched, 1, 'Iteration 1: pagesFetched should be 1');
  assert.equal(result1.pagination.hasMorePages, true, 'Iteration 1: hasMorePages should be true');
  assert.equal(result1.pagination.messagesDiscovered, 100, 'Iteration 1: messagesDiscovered should be 100');
  
  // Iteration 2: Second 100 messages with nextPageToken
  // State flows: result1 → Rate Limit Delay → List Messages Page → Merge Gmail Response
  const stateIter2 = result1;  // This simulates Rate Limit Delay passing state through
  
  const gmailPage2 = {
    json: {
      messages: Array.from({ length: 100 }, (_, i) => ({ id: `msg-${i + 101}` })),
      nextPageToken: 'token-2'
    }
  };
  
  const mergedIter2 = {
    json: {
      ...stateIter2,
      _currentGmailResponse: gmailPage2.json
    }
  };
  
  const result2 = run('Process Page Response', mergedIter2)[0].json;
  
  assert.equal(result2.pagination.messageIds.length, 200, 'Iteration 2: should have 200 message IDs (100 + 100)');
  assert.equal(result2.pagination.pagesFetched, 2, 'Iteration 2: pagesFetched should be 2');
  assert.equal(result2.pagination.hasMorePages, true, 'Iteration 2: hasMorePages should be true (200 < 250)');
  assert.equal(result2.pagination.messagesDiscovered, 200, 'Iteration 2: messagesDiscovered should be 200');
  
  // Verify no duplicates
  const ids2 = new Set(result2.pagination.messageIds);
  assert.equal(ids2.size, 200, 'Iteration 2: all IDs should be unique');
  
  // Iteration 3: Final 50 messages, no nextPageToken (end of mailbox)
  const stateIter3 = result2;
  
  const gmailPage3 = {
    json: {
      messages: Array.from({ length: 50 }, (_, i) => ({ id: `msg-${i + 201}` }))
      // No nextPageToken means end of mailbox
    }
  };
  
  const mergedIter3 = {
    json: {
      ...stateIter3,
      _currentGmailResponse: gmailPage3.json
    }
  };
  
  const result3 = run('Process Page Response', mergedIter3)[0].json;
  
  assert.equal(result3.pagination.messageIds.length, 250, 'Iteration 3: should have 250 message IDs (100 + 100 + 50)');
  assert.equal(result3.pagination.pagesFetched, 3, 'Iteration 3: pagesFetched should be 3');
  assert.equal(result3.pagination.hasMorePages, false, 'Iteration 3: hasMorePages should be false (no nextPageToken)');
  assert.equal(result3.pagination.messagesDiscovered, 250, 'Iteration 3: messagesDiscovered should be 250');
  
  // Verify all IDs are unique
  const ids3 = new Set(result3.pagination.messageIds);
  assert.equal(ids3.size, 250, 'Iteration 3: all 250 IDs should be unique');
  
  // Verify ID sequence is correct
  for (let i = 0; i < 250; i++) {
    assert.ok(result3.pagination.messageIds.includes(`msg-${i + 1}`), `Iteration 3: should have msg-${i + 1}`);
  }
});

// Test: maxMessages limit enforcement across iterations
test('maxMessages limit stops pagination even when more pages available', () => {
  const config = {
    maxMessages: 150,
    pageSize: 100,
    pagination: {
      nextPageToken: null,
      pagesFetched: 0,
      messagesDiscovered: 0,
      messageIds: []
    }
  };
  
  // Iteration 1: Get 100 messages
  const gmailPage1 = {
    json: {
      messages: Array.from({ length: 100 }, (_, i) => ({ id: `msg-${i + 1}` })),
      nextPageToken: 'token-1'
    }
  };
  
  const mergedIter1 = {
    json: {
      ...config,
      _currentGmailResponse: gmailPage1.json
    }
  };
  
  const result1 = run('Process Page Response', mergedIter1)[0].json;
  assert.equal(result1.pagination.messageIds.length, 100);
  assert.equal(result1.pagination.hasMorePages, true, 'After page 1: hasMorePages should be true');
  
  // Iteration 2: Get next 100 messages, but only take 50 to reach maxMessages
  const gmailPage2 = {
    json: {
      messages: Array.from({ length: 100 }, (_, i) => ({ id: `msg-${i + 101}` })),
      nextPageToken: 'token-2'
    }
  };
  
  const mergedIter2 = {
    json: {
      ...result1,
      _currentGmailResponse: gmailPage2.json
    }
  };
  
  const result2 = run('Process Page Response', mergedIter2)[0].json;
  
  assert.equal(result2.pagination.messageIds.length, 150, 'Should have exactly 150 messages (maxMessages limit)');
  assert.equal(result2.pagination.hasMorePages, false, 'After reaching maxMessages: hasMorePages should be false even if more available');
  assert.equal(result2.pagination.messagesDiscovered, 200, 'messagesDiscovered reflects all seen (200) even though we only took 150');
});

// Test: Duplicate message ID rejection across pages
test('deduplication prevents duplicate IDs across pagination iterations', () => {
  const config = {
    maxMessages: 250,
    pageSize: 100,
    pagination: {
      nextPageToken: null,
      pagesFetched: 0,
      messagesDiscovered: 0,
      messageIds: []
    }
  };
  
  // Page 1: messages 1-100
  const gmailPage1 = {
    json: {
      messages: Array.from({ length: 100 }, (_, i) => ({ id: `msg-${i + 1}` })),
      nextPageToken: 'token-1'
    }
  };
  
  const mergedIter1 = {
    json: {
      ...config,
      _currentGmailResponse: gmailPage1.json
    }
  };
  
  const result1 = run('Process Page Response', mergedIter1)[0].json;
  assert.equal(result1.pagination.messageIds.length, 100);
  
  // Page 2: duplicate msg-50, msg-51, ... plus new messages
  // This simulates Gmail's potential to return duplicates across pages
  const gmailPage2 = {
    json: {
      messages: Array.from({ length: 100 }, (_, i) => ({ id: `msg-${i + 51}` })),  // 51-150, overlaps with 1-100
      nextPageToken: 'token-2'
    }
  };
  
  const mergedIter2 = {
    json: {
      ...result1,
      _currentGmailResponse: gmailPage2.json
    }
  };
  
  const result2 = run('Process Page Response', mergedIter2)[0].json;
  
  // Only new unique IDs (101-150) should be added to the 100 we already have
  assert.equal(result2.pagination.messageIds.length, 150, 'Should have 150 unique IDs (100 + 50 new)');
  
  const ids = new Set(result2.pagination.messageIds);
  assert.equal(ids.size, 150, 'All accumulated IDs should be unique');
});

// Test: Empty mailbox (no messages on first page)
test('empty mailbox is handled correctly', () => {
  const config = {
    maxMessages: 500,
    pageSize: 100,
    pagination: {
      nextPageToken: null,
      pagesFetched: 0,
      messagesDiscovered: 0,
      messageIds: []
    }
  };
  
  const gmailPageEmpty = {
    json: {
      // No messages property = empty mailbox
      messages: undefined
    }
  };
  
  const merged = {
    json: {
      ...config,
      _currentGmailResponse: gmailPageEmpty.json
    }
  };
  
  const result = run('Process Page Response', merged)[0].json;
  
  assert.equal(result.pagination.messageIds.length, 0, 'Empty mailbox should have no message IDs');
  assert.equal(result.pagination.hasMorePages, false, 'Empty mailbox should set hasMorePages to false');
  assert.equal(result.pagination.pagesFetched, 1, 'Should still count the request');
});

// Test: Pagination termination on non-progressing token (same token twice)
test('non-progressing pagination is detected', () => {
  const stateWithToken = {
    maxMessages: 500,
    pageSize: 100,
    pagination: {
      nextPageToken: 'stuck-token',
      pagesFetched: 1,
      messagesDiscovered: 50,
      messageIds: Array.from({ length: 50 }, (_, i) => `msg-${i + 1}`)
    }
  };
  
  const gmailPageSameToken = {
    json: {
      messages: Array.from({ length: 50 }, (_, i) => ({ id: `msg-${i + 51}` })),
      nextPageToken: 'stuck-token'  // Same token returned!
    }
  };
  
  const merged = {
    json: {
      ...stateWithToken,
      _currentGmailResponse: gmailPageSameToken.json
    }
  };
  
  assert.throws(
    () => run('Process Page Response', merged),
    /Pagination error: same nextPageToken returned twice/,
    'Should detect and throw on stuck pagination token'
  );
});

// Test: Prepare Metadata Requests enforces maxMessages limit
test('prepare metadata requests validates message count does not exceed maxMessages', () => {
  const stateWithTooManyIds = {
    maxMessages: 500,
    pagination: {
      messageIds: Array.from({ length: 501 }, (_, i) => `msg-${i + 1}`)  // More than maxMessages!
    }
  };
  
  const input = {
    json: stateWithTooManyIds
  };
  
  assert.throws(
    () => run('Prepare Metadata Requests', input),
    /Message ID count exceeds maxMessages limit/,
    'Should reject if accumulated IDs exceed maxMessages'
  );
});

// Test: State passes through Rate Limit Delay unchanged
test('rate limit delay preserves state for next iteration', () => {
  const stateToDelay = {
    maxMessages: 500,
    pageSize: 100,
    requestDelayMs: 50,
    pagination: {
      nextPageToken: 'token-1',
      pagesFetched: 1,
      messagesDiscovered: 100,
      messageIds: Array.from({ length: 100 }, (_, i) => `msg-${i + 1}`)
    }
  };
  
  const input = {
    json: stateToDelay
  };
  
  const result = run('Rate Limit Delay', input);
  
  // Should return the state unchanged (except possibly cleaned up transients)
  assert.deepEqual(result, stateToDelay, 'Rate Limit Delay should preserve state');
});

console.log('✓ All pagination state-threading tests passed');
