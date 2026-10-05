require('dotenv').config();

const AUTO_REVIEW_RERUN_LIMIT = Math.max(0, parseInt(process.env.AUTO_REVIEW_RERUN_LIMIT || '1', 10) || 1);
const AUTO_REVIEW_RERUN_DELAY_MS = Math.max(0, parseInt(process.env.AUTO_REVIEW_RERUN_DELAY_MS || '4000', 10) || 4000);

const REVIEW_RETRY_PATTERNS = [
  /named people were mentioned without matching person-specific portrait searches/i,
  /more than half of the scenes used lower-resolution source media/i,
  /one or more scene search terms still look like headline questions/i,
  /too many scenes still rely on generic portrait searches/i,
  /no factual editorial imagery/i,
  /editorial imagery/i,
];

function getReviewReasons(result = {}) {
  if (Array.isArray(result.reviewReasons) && result.reviewReasons.length > 0) {
    return result.reviewReasons.filter(Boolean).map((reason) => String(reason));
  }

  if (typeof result.error === 'string' && result.error.trim()) {
    return [result.error.trim()];
  }

  return [];
}

function isAutoRetryableReview(result = {}) {
  if (!result || String(result.uploadReadiness || '').toLowerCase() !== 'review') {
    return false;
  }

  const reasons = getReviewReasons(result);
  return reasons.some((reason) => REVIEW_RETRY_PATTERNS.some((pattern) => pattern.test(reason)));
}

function getAutoRetrySummary(result = {}) {
  return getReviewReasons(result).join('; ') || 'Quality review required';
}

module.exports = {
  AUTO_REVIEW_RERUN_LIMIT,
  AUTO_REVIEW_RERUN_DELAY_MS,
  getAutoRetrySummary,
  isAutoRetryableReview,
};
