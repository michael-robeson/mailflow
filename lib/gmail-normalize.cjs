'use strict';

function headersOf(part, warnings) {
  if (part?.headers == null) return [];
  if (!Array.isArray(part.headers)) {
    warnings.add('invalid_headers');
    return [];
  }
  return part.headers.filter((header) => {
    if (!header || typeof header.name !== 'string' || typeof header.value !== 'string') {
      warnings.add('invalid_headers');
      return false;
    }
    return true;
  });
}

function headerValue(headers, name, warnings) {
  const values = headers.filter((header) => header.name.trim().toLowerCase() === name);
  if (values.length > 1) {
    warnings.add(`duplicate_${name.replace(/-/g, '_')}_header`);
    return null;
  }
  return values.length ? values[0].value.replace(/\r?\n[ \t]+/g, ' ').trim() : null;
}

function senderFrom(value, warnings) {
  const missing = { name: null, address: null };
  if (!value) return missing;
  const angle = value.match(/^\s*([^<>]*)<\s*([^<>\s]+)\s*>\s*$/);
  const address = angle ? angle[2] : value.trim();
  const valid = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(address);
  if (!valid || address.includes('..')) {
    warnings.add('invalid_sender');
    return missing;
  }
  let name = angle ? angle[1].trim() : '';
  if (name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1).replace(/\\(["\\])/g, '$1').trim();
  }
  return { name: name || null, address: address.toLowerCase() };
}

function receivedAt(message, headers, warnings) {
  if (message.internalDate != null) {
    const raw = message.internalDate;
    if ((typeof raw === 'string' && /^\d+$/.test(raw)) ||
        (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0)) {
      const date = new Date(Number(raw));
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
    warnings.add('invalid_internal_date');
  }
  const value = headerValue(headers, 'date', warnings);
  if (!value) return null;
  // Avoid machine-local timezone assumptions for unzoned Date headers.
  if (!/(?:[+-]\d{4}|GMT|UTC)\s*$/i.test(value)) {
    warnings.add('invalid_date_header');
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    warnings.add('invalid_date_header');
    return null;
  }
  return new Date(timestamp).toISOString();
}

function decodeBody(part, headers, warnings) {
  const body = part.body;
  if (body == null) return null;
  if (typeof body !== 'object' || Array.isArray(body)) {
    warnings.add('invalid_body');
    return null;
  }
  if (body.data == null) {
    if (body.attachmentId || (typeof body.size === 'number' && body.size > 0)) warnings.add('external_body_unavailable');
    return null;
  }
  const data = body.data;
  if (typeof data !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(data) ||
      data.replace(/=+$/, '').length % 4 === 1 ||
      (data.includes('=') && data.length % 4 !== 0)) {
    warnings.add('invalid_body_encoding');
    return null;
  }
  const bytes = Buffer.from(data, 'base64url');
  if (bytes.toString('base64url') !== data.replace(/=+$/, '')) {
    warnings.add('invalid_body_encoding');
    return null;
  }
  const contentType = headerValue(headers, 'content-type', warnings) || '';
  const charset = contentType.match(/(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
  try {
    return new TextDecoder(charset?.[1] || charset?.[2] || 'utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (!(error instanceof RangeError || error instanceof TypeError)) throw error;
    warnings.add('invalid_body_charset_or_text');
    return null;
  }
}

function htmlToText(html) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(script|style|head|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    .replace(/<\s*(?:br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/\s*(?:p|div|li|tr|h[1-6]|blockquote|pre)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
      if (entity[0] !== '#') return entities[entity.toLowerCase()];
      const hex = entity[1].toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code) : '\ufffd';
    })
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractBody(payload, warnings) {
  const visited = new WeakSet();
  let count = 0;
  function visit(part, depth) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      warnings.add('invalid_mime_part');
      return null;
    }
    if (visited.has(part) || depth > 100 || ++count > 10000) {
      warnings.add('mime_structure_limit');
      return null;
    }
    visited.add(part);
    const headers = headersOf(part, warnings);
    const disposition = headerValue(headers, 'content-disposition', warnings) || '';
    if ((typeof part.filename === 'string' && part.filename.trim()) || /^\s*attachment\b/i.test(disposition)) return null;
    const mime = typeof part.mimeType === 'string' ? part.mimeType.split(';', 1)[0].trim().toLowerCase() : '';
    if (mime === 'message/rfc822') return null;
    if (mime === 'text/plain' || mime === 'text/html') {
      const decoded = decodeBody(part, headers, warnings);
      if (decoded == null) return null;
      const text = mime === 'text/html' ? htmlToText(decoded) : decoded;
      return text.trim() ? { text, kind: mime === 'text/plain' ? 'plain' : 'html' } : null;
    }
    if (part.parts != null && !Array.isArray(part.parts)) {
      warnings.add('invalid_mime_parts');
      return null;
    }
    if (!Array.isArray(part.parts)) {
      if (part.body?.data && !mime) warnings.add('missing_body_mime_type');
      return null;
    }
    const children = part.parts.map((child) => visit(child, depth + 1)).filter(Boolean);
    if (!children.length) return null;
    if (mime === 'multipart/alternative') {
      return children.find((child) => child.kind === 'plain') || children[0];
    }
    return { text: children.map((child) => child.text).join('\n\n'), kind: children.some((child) => child.kind === 'plain') ? 'plain' : 'html' };
  }
  return payload ? visit(payload, 0)?.text ?? '' : '';
}

function normalizeGmailMessage(message) {
  const warnings = new Set();
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    warnings.add('invalid_message');
    message = {};
  }
  const payload = message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload)
    ? message.payload : null;
  if (message.payload != null && !payload) warnings.add('invalid_payload');
  const headers = headersOf(payload, warnings);
  const id = typeof message.id === 'string' && message.id.trim() ? message.id : null;
  const threadId = typeof message.threadId === 'string' && message.threadId.trim() ? message.threadId : null;
  if (!id) warnings.add('missing_or_invalid_id');
  if (message.threadId != null && !threadId) warnings.add('invalid_thread_id');
  const sender = senderFrom(headerValue(headers, 'from', warnings), warnings);
  const subject = headerValue(headers, 'subject', warnings);
  const timestamp = receivedAt(message, headers, warnings);
  const body = extractBody(payload, warnings);
  return { schemaVersion: '1.0', id, threadId, sender, subject, receivedAt: timestamp, body, warnings: [...warnings] };
}

module.exports = { normalizeGmailMessage };
