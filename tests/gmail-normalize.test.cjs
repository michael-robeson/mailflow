'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeGmailMessage } = require('../lib/gmail-normalize.cjs');

const encoded = (text) => Buffer.from(text, 'utf8').toString('base64url');
const header = (name, value) => ({ name, value });
const part = (mimeType, text, extra = {}) => ({
  mimeType, body: { data: encoded(text) }, ...extra,
});

test('normalizes a plain-text Gmail message without mutating its input', () => {
  const message = {
    id: 'msg_001', threadId: 'thread_002', internalDate: '1704067200000',
    payload: part('text/plain', 'Hello, world!\n', { headers: [
      header('fRoM', '  "Example Sender" <Sender@Example.test>  '),
      header('Subject', '  Hello\r\n world  '),
      header('Date', 'Tue, 2 Jan 2024 00:00:00 +0000'),
    ] }),
  };
  const original = structuredClone(message);
  assert.deepEqual(normalizeGmailMessage(message), {
    schemaVersion: '1.0',
    id: 'msg_001', threadId: 'thread_002',
    sender: { name: 'Example Sender', address: 'sender@example.test' },
    subject: 'Hello world', receivedAt: '2024-01-01T00:00:00.000Z',
    body: 'Hello, world!\n', warnings: [],
  });
  assert.deepEqual(message, original);
});

test('selects plain alternatives, combines mixed parts, and skips attachments', () => {
  const result = normalizeGmailMessage({
    id: 'multipart', payload: { mimeType: 'multipart/mixed', parts: [
      { mimeType: 'multipart/alternative', parts: [
        part('text/html', '<p>HTML duplicate</p>'),
        part('text/plain', 'First section'),
      ] },
      part('text/plain', 'Second section'),
      part('text/plain', 'Attachment text', { filename: 'attached.txt' }),
      part('text/plain', 'Hidden attachment', { headers: [header('Content-Disposition', 'attachment; filename="x"')] }),
      part('application/pdf', 'not message text'),
      { mimeType: 'message/rfc822', parts: [part('text/plain', 'Forwarded attachment')] },
    ] },
  });
  assert.equal(result.body, 'First section\n\nSecond section');
  assert.deepEqual(result.warnings, []);
});

test('uses HTML fallback as inert readable text without rendering or executing it', () => {
  const result = normalizeGmailMessage({
    id: 'html', payload: { mimeType: 'multipart/alternative', parts: [
      part('text/html', '<html><head><title>hidden</title></head><body><p>Hello &amp; welcome</p><script>danger()</script><style>.x{}</style><div>Next<br>line &#x1F600; &lt;literal&gt;</div><!-- hidden --></body></html>'),
      part('text/plain', ''),
    ] },
  });
  assert.equal(result.body, 'Hello & welcome\nNext\nline 😀 <literal>');
  assert.deepEqual(result.warnings, []);
});

test('HTML-derived text remains untrusted and may contain markup-like text', () => {
  const result = normalizeGmailMessage({
    id: 'html', payload: part('text/html', '<p>&lt;img src=x onerror=alert(1)&gt;</p>'),
  });
  assert.equal(result.schemaVersion, '1.0');
  assert.equal(result.body, '<img src=x onerror=alert(1)>');
});

test('uses Gmail internalDate and falls back to explicitly zoned Date headers', () => {
  const message = { id: 'date', internalDate: 'not-a-date', payload: { headers: [
    header('Date', 'Mon, 01 Jan 2024 02:00:00 +0200'),
  ] } };
  const result = normalizeGmailMessage(message);
  assert.equal(result.receivedAt, '2024-01-01T00:00:00.000Z');
  assert.deepEqual(result.warnings, ['invalid_internal_date']);
  const unzoned = normalizeGmailMessage({ id: 'date', payload: { headers: [header('Date', 'Mon, 01 Jan 2024 02:00:00')] } });
  assert.equal(unzoned.receivedAt, null);
  assert.deepEqual(unzoned.warnings, ['invalid_date_header']);
});

test('handles empty or invalid messages with explicit warnings and stable output', () => {
  assert.deepEqual(normalizeGmailMessage(null), {
    schemaVersion: '1.0',
    id: null, threadId: null, sender: { name: null, address: null },
    subject: null, receivedAt: null, body: '',
    warnings: ['invalid_message', 'missing_or_invalid_id'],
  });
  assert.deepEqual(normalizeGmailMessage({ id: 'empty' }), {
    schemaVersion: '1.0',
    id: 'empty', threadId: null, sender: { name: null, address: null },
    subject: null, receivedAt: null, body: '', warnings: [],
  });
  const malformed = normalizeGmailMessage({
    id: 'x', threadId: {}, payload: { mimeType: 'text/plain', headers: [null, header('From', 'broken-address')], body: { data: '%' } },
  });
  assert.equal(malformed.body, '');
  assert.deepEqual(malformed.sender, { name: null, address: null });
  assert.deepEqual(malformed.warnings, ['invalid_headers', 'invalid_thread_id', 'invalid_sender', 'invalid_body_encoding']);
});

test('accepts valid base64url padding and rejects malformed or invalid UTF-8 data', () => {
  for (const data of ['aGk', 'aGk=']) {
    assert.equal(normalizeGmailMessage({ id: 'x', payload: { mimeType: 'text/plain', body: { data } } }).body, 'hi');
  }
  for (const data of ['a', 'abcd=', 'aGk==', 'a+b/', 'Zh', '_w']) {
    const result = normalizeGmailMessage({ id: 'x', payload: { mimeType: 'text/plain', body: { data } } });
    assert.equal(result.body, '', data);
    assert.ok(result.warnings.includes(data === '_w' ? 'invalid_body_charset_or_text' : 'invalid_body_encoding'), data);
  }
});

test('reports unavailable external bodies and malformed charset while falling back to HTML', () => {
  const result = normalizeGmailMessage({ id: 'x', payload: { mimeType: 'multipart/alternative', parts: [
    { mimeType: 'text/plain', body: { attachmentId: 'external' } },
    { mimeType: 'text/plain', headers: [header('Content-Type', 'text/plain; charset=unknown-charset')], body: { data: encoded('hidden') } },
    part('text/html', '<p>Available</p>'),
  ] } });
  assert.equal(result.body, 'Available');
  assert.deepEqual(result.warnings, ['external_body_unavailable', 'invalid_body_charset_or_text']);
});

test('handles duplicate headers, malformed parts, and cyclic structures without leaking content', () => {
  const payload = { mimeType: 'multipart/mixed', headers: [
    header('From', 'a@example.test'), header('FROM', 'b@example.test'),
    header('Subject', 'one'), header('Subject', 'two'),
  ], parts: [null] };
  payload.parts.push(payload);
  const result = normalizeGmailMessage({ id: 'x', payload });
  assert.equal(result.subject, null);
  assert.equal(result.sender.address, null);
  assert.deepEqual(result.warnings, ['duplicate_from_header', 'duplicate_subject_header', 'invalid_mime_part', 'mime_structure_limit']);
  assert.ok(result.warnings.every((warning) => !warning.includes('@')));
});

test('bare senders and explicitly declared charsets are normalized', () => {
  const result = normalizeGmailMessage({ id: 'x', payload: {
    mimeType: 'text/plain',
    headers: [header('From', ' User@Example.TEST '), header('Content-Type', 'text/plain; charset="windows-1252"')],
    body: { data: Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('base64url') },
  } });
  assert.deepEqual(result.sender, { name: null, address: 'user@example.test' });
  assert.equal(result.body, 'café');
  assert.deepEqual(result.warnings, []);
});

test('preserves fallback text and reports invalid body structures without logging message content', () => {
  const originalLog = console.log;
  const originalError = console.error;
  const calls = [];
  console.log = (...args) => calls.push(args);
  console.error = (...args) => calls.push(args);
  try {
    const result = normalizeGmailMessage({ id: 'x', payload: { mimeType: 'multipart/mixed', parts: [
      { mimeType: 'text/plain', body: 'invalid' },
      { mimeType: 'text/plain', body: { size: 12 } },
      { mimeType: 'multipart/alternative', parts: [
        { mimeType: 'text/plain', body: { data: '%' } },
        part('text/html', '<p>fallback</p>'),
      ] },
      { mimeType: 'multipart/mixed', parts: 'invalid' },
    ] } });
    assert.equal(result.body, 'fallback');
    assert.deepEqual(result.warnings, ['invalid_body', 'external_body_unavailable', 'invalid_body_encoding', 'invalid_mime_parts']);
    assert.deepEqual(calls, []);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});
