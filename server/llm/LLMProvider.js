/** Provider contract: local Codex CLI or OpenAI API can be swapped without changing routes. */
export class LLMProvider {
  async analyzeWork(_description, _existingSkills) { throw new Error('Not implemented'); }
  async respondWithTools(_messages, _approvedSkills, _executeTool) { throw new Error('Not implemented'); }
}
