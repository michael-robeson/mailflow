'use strict';

const RULES = [
  {
    id: 'rejection_application_outcome',
    category: 'application_rejection',
    patterns: [
      /\b(?:we(?:'re| are) unable to|we (?:will|have decided to) not|we (?:won't|will not)) (?:move|proceed) (?:forward|further) with (?:your|the) application\b/i,
      /\b(?:your application|your candidacy) (?:(?:has not been|was not|is not) (?:selected|successful|approved)|has been unsuccessful|was unsuccessful)\b/i,
      /\b(?:not selected|no longer (?:being )?considered) for (?:this|the|our) (?:role|position|job)\b/i,
      /\b(?:decided to|will) (?:move|proceed) forward with other candidates\b/i,
    ],
  },
  {
    id: 'interview_invitation',
    category: 'interview_request',
    patterns: [
      /\b(?:schedule|arrange|book|invite you to|invitation to|invited to|availability for|available for) (?:an? |your |the )?(?:job |technical |onsite |on-site |video |final )?interview\b/i,
      /\b(?:interview) (?:invitation|request|scheduling|availability)\b/i,
      /\b(?:would like|we'd like|we would like) to interview you\b/i,
    ],
  },
  {
    id: 'screening_invitation',
    category: 'screening_request',
    patterns: [
      /\b(?:schedule|arrange|book|invite you to|invitation to|invited to|availability for|available for) (?:an? |your |the )?(?:phone |recruiter |initial |technical )?(?:screen|screening)(?: call)?\b/i,
      /\b(?:phone |recruiter |initial |technical )?(?:screen|screening) (?:call |interview )?(?:invitation|request|scheduling|availability)\b/i,
      /\b(?:would like|we'd like|we would like) to (?:speak with you|screen you) about (?:your application|the role|the position)\b/i,
    ],
  },
  {
    id: 'application_received',
    category: 'application_confirmation',
    patterns: [
      /\b(?:we(?:'ve| have) received|we received|thank you for submitting) your application\b/i,
      /\b(?:application|application submission) (?:received|confirmation|submitted successfully)\b/i,
      /\bthank you for applying (?:for|to)\b/i,
    ],
  },
  {
    id: 'application_status_update',
    category: 'application_update',
    patterns: [
      /\b(?:an? |your |the )?(?:application|candidacy) (?:status )?update\b/i,
      /\b(?:update|status) (?:on|of|regarding) your application\b/i,
      /\byour application (?:is|remains) (?:under review|in review|being reviewed|in progress)\b/i,
    ],
  },
  {
    id: 'job_alert_digest',
    category: 'job_alert',
    patterns: [
      /\b(?:your |new |daily |weekly )?(?:job|jobs) alerts?\b/i,
      /\b(?:new |latest )?(?:jobs|job openings|job listings) (?:for you|matching your (?:search|preferences|profile))\b/i,
    ],
  },
  {
    id: 'recruiter_direct_outreach',
    category: 'recruiter_contact',
    patterns: [
      /\b(?:i am|i'm|i work as|my name is .{1,60} and i am) (?:an? |a technical |a senior )?(?:recruiter|talent acquisition specialist)\b/i,
      /\b(?:reaching out|contacting you) (?:about|regarding) (?:an? |the |a new )?(?:job |career |employment )?(?:opportunity|position|role)\b/i,
      /\b(?:interested in|considering) (?:an? |the |a new )?(?:job |career )?(?:opportunity|position|role) (?:at|with)\b/i,
    ],
  },
];

const NEGATION = /\b(?:no|not|never|don't|do not|isn't|is not|aren't|are not|cannot|can't|without)\b/i;
const CANCELLED = /\b(?:cancelled|canceled|declined|withdrawn)\b/i;

function classifyEmail(message) {
  const result = {
    schemaVersion: '1.0',
    messageId: null,
    category: 'other',
    matchedRuleIds: [],
    explanationCodes: [],
    status: 'invalid_input',
  };
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    result.explanationCodes.push('invalid_message');
    return result;
  }
  if (typeof message.id === 'string' && message.id.trim()) result.messageId = message.id;
  if (message.schemaVersion !== '1.0') {
    result.status = 'unsupported_schema';
    result.explanationCodes.push('unsupported_schema_version');
    return result;
  }
  if ((message.id != null && typeof message.id !== 'string') ||
      (message.subject != null && typeof message.subject !== 'string') ||
      (message.body != null && typeof message.body !== 'string') ||
      (message.sender != null && (typeof message.sender !== 'object' || Array.isArray(message.sender))) ||
      (message.sender?.name != null && typeof message.sender.name !== 'string') ||
      (message.sender?.address != null && typeof message.sender.address !== 'string')) {
    result.explanationCodes.push('invalid_field_type');
    return result;
  }

  const subject = message.subject || '';
  const body = message.body || '';
  const sender = `${message.sender?.name || ''} ${message.sender?.address || ''}`;
  const text = `${subject}\n${body}`;
  const segments = text.split(/[.!?\r\n;]+/).map((segment) => segment.trim()).filter(Boolean);
  const matches = [];
  for (const rule of RULES) {
    if (segments.some((segment) => rule.patterns.some((pattern) => {
      if (!pattern.test(segment)) return false;
      // Rejection patterns contain intentional negatives; other rules must not
      // turn a negated request into a positive classification.
      if (rule.category === 'application_rejection') return true;
      return !NEGATION.test(segment) && !CANCELLED.test(segment);
    }))) matches.push(rule);
  }

  // Sender role alone is insufficient; require job-related outreach as well.
  if (/\b(?:recruiter|recruiting|talent acquisition)\b/i.test(sender) &&
      segments.some((segment) => !NEGATION.test(segment) && !CANCELLED.test(segment) &&
        /\b(?:job|career|hiring|role|position|opportunity)\b/i.test(segment)) &&
      !matches.some((rule) => rule.id === 'recruiter_direct_outreach')) {
    matches.push(RULES[RULES.length - 1]);
  }

  if (!matches.length) {
    result.status = 'insufficient_evidence';
    result.explanationCodes.push('no_positive_rule');
    if (!result.messageId) result.explanationCodes.push('missing_message_id');
    return result;
  }
  result.status = 'matched';
  result.category = matches[0].category;
  result.matchedRuleIds = matches.map((rule) => rule.id);
  result.explanationCodes.push('positive_rule_matched');
  if (matches.length > 1) result.explanationCodes.push('precedence_applied');
  if (!result.messageId) result.explanationCodes.push('missing_message_id');
  return result;
}

module.exports = { classifyEmail };
