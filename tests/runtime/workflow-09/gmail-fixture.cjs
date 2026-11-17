'use strict';

const http = require('node:http');

const PAGE_SIZE = 2;
const PAGES = new Map([
  ['', { ids: ['w09_msg_001', 'w09_msg_002'], nextPageToken: 'w09_page_2' }],
  ['w09_page_2', { ids: ['w09_msg_003', 'w09_msg_004'], nextPageToken: 'w09_page_3' }],
  ['w09_page_3', { ids: ['w09_msg_005'] }],
]);
const MESSAGE_IDS = new Set([...PAGES.values()].flatMap(({ ids }) => ids));

function createServer({ onEvent = (event) => console.log(JSON.stringify(event)) } = {}) {
  let sequence = 0;
  let listPagesServed = 0;
  const checkpointPages = new Set();
  const record = (event) => onEvent({
    sequence: ++sequence,
    receivedAtMs: Date.now(),
    ...event,
  });

  return http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/healthz') {
      response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }

    if (request.method === 'GET' && url.pathname === '/checkpoint') {
      const pageNumber = Number(url.searchParams.get('pageNumber'));
      if (!Number.isInteger(pageNumber) || pageNumber !== checkpointPages.size + 1
        || pageNumber > listPagesServed) {
        record({ type: 'rejected_checkpoint', pageNumber });
        response.writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'unexpected_checkpoint' }));
        return;
      }

      checkpointPages.add(pageNumber);
      record({ type: 'checkpoint', pageNumber });
      response.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ accepted: true }));
      return;
    }

    if (request.method !== 'GET') {
      record({ type: 'rejected', method: request.method, path: url.pathname });
      response.writeHead(405, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

    if (url.pathname === '/gmail/v1/users/me/messages') {
      const pageToken = url.searchParams.get('pageToken') ?? '';
      const page = PAGES.get(pageToken);
      const maxResults = Number(url.searchParams.get('maxResults'));
      const expectedToken = ['', 'w09_page_2', 'w09_page_3'][listPagesServed];
      if (!page || maxResults !== PAGE_SIZE || pageToken !== expectedToken) {
        record({ type: 'rejected_list', pageToken, maxResults });
        response.writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'unexpected_list_request' }));
        return;
      }

      if (checkpointPages.size !== listPagesServed) {
        record({ type: 'rejected_list_order', pageToken: pageToken || null });
        response.writeHead(409, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'checkpoint_required_before_next_page' }));
        return;
      }

      listPagesServed++;
      record({ type: 'list', pageToken: pageToken || null, maxResults });
      const body = { messages: page.ids.map((id) => ({ id })) };
      if (page.nextPageToken) body.nextPageToken = page.nextPageToken;
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      return;
    }

    const messageMatch = url.pathname.match(/^\/gmail\/v1\/users\/me\/messages\/([A-Za-z0-9_-]+)$/);
    if (messageMatch) {
      const messageId = messageMatch[1];
      if (!MESSAGE_IDS.has(messageId) || url.searchParams.get('format') !== 'full') {
        record({ type: 'rejected_message', messageId });
        response.writeHead(404, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'unexpected_message_request' }));
        return;
      }

      record({ type: 'message', messageId });
      const body = {
        id: messageId,
        payload: {
          mimeType: 'text/plain',
          headers: [{ name: 'Subject', value: 'Job alert' }],
          body: { data: Buffer.from('New jobs matching your preferences.').toString('base64url') },
        },
      };
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      return;
    }

    record({ type: 'rejected', method: request.method, path: url.pathname });
    response.writeHead(404, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: 'not_found' }));
  });
}

if (require.main === module) {
  createServer().listen(8080, '0.0.0.0');
}

module.exports = { createServer, PAGE_SIZE, PAGES };
