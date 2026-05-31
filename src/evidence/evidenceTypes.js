export const EVIDENCE_TYPES = {
  WEB_SEARCH_RESULT: 'web_search_result',
  FETCHED_PAGE: 'fetched_page',
  PAPER: 'paper',
  CITATION_EDGE: 'citation_edge',
  FAILURE: 'failure'
};

export const CONFIDENCE_LEVELS = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  UNVERIFIED: 'unverified'
};

export const EVIDENCE_GRADES = {
  S: 'S',
  A_PLUS: 'A+',
  A: 'A',
  B: 'B',
  C: 'C',
  D: 'D'
};

export function gradeFromSource(isPeerReviewed, isOpenAccess, hasCode, citationCount) {
  if (isPeerReviewed && isOpenAccess && hasCode && citationCount >= 50) {
    return EVIDENCE_GRADES.S;
  }
  if (isPeerReviewed && citationCount >= 20) {
    return EVIDENCE_GRADES.A_PLUS;
  }
  if (isOpenAccess && hasCode && citationCount >= 5) {
    return EVIDENCE_GRADES.A;
  }
  if (isOpenAccess || citationCount >= 1) {
    return EVIDENCE_GRADES.B;
  }
  return EVIDENCE_GRADES.C;
}

export function confidenceLevelFromScore(score) {
  if (score >= 0.9) return CONFIDENCE_LEVELS.HIGH;
  if (score >= 0.6) return CONFIDENCE_LEVELS.MEDIUM;
  if (score >= 0.3) return CONFIDENCE_LEVELS.LOW;
  return CONFIDENCE_LEVELS.UNVERIFIED;
}
