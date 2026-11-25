const strings = { type: 'string' };
const evidenceItem = {
  type: 'object', additionalProperties: false,
  properties: { statement: strings, evidence: strings, needsValidation: { type: 'boolean' } },
  required: ['statement', 'evidence', 'needsValidation']
};
const skill = {
  type: 'object', additionalProperties: false,
  properties: {
    title: strings, purpose: strings, existingSkillId: strings,
    inputs: { type: 'array', items: evidenceItem },
    steps: { type: 'array', items: evidenceItem },
    decisions: { type: 'array', items: evidenceItem },
    exceptions: { type: 'array', items: evidenceItem },
    tools: { type: 'array', items: evidenceItem },
    expectedResult: evidenceItem,
    allowedAutomation: { type: 'array', items: evidenceItem },
    sources: { type: 'array', items: strings },
    unknowns: { type: 'array', items: strings }
  },
  required: ['title', 'purpose', 'existingSkillId', 'inputs', 'steps', 'decisions', 'exceptions', 'tools', 'expectedResult', 'allowedAutomation', 'sources', 'unknowns']
};
export const SKILL_ANALYSIS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    summary: strings,
    clarificationQuestions: { type: 'array', items: strings },
    skills: { type: 'array', items: skill }
  },
  required: ['summary', 'clarificationQuestions', 'skills']
};
