import OpenAI from 'openai';
import { LLMProvider } from './LLMProvider.js';
import { SKILL_ANALYSIS_SCHEMA } from './schemas.js';
import { TOOLS } from '../skills/tools.js';

import { ANALYSIS_INSTRUCTIONS, TWIN_INSTRUCTIONS } from './prompts.js';

export class OpenAIProvider extends LLMProvider {
  constructor() {
    super();
    this.client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
    this.model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  }
  get ready() { return Boolean(this.client); }
  async analyzeWork(description, existingSkills, beforeRequest) {
    if (!beforeRequest()) throw Object.assign(new Error('Daily AI request limit reached.'), { code:'LOCAL_DAILY_LIMIT' });
    const response = await this.client.responses.create({
      model: this.model,
      store: false,
      max_output_tokens: 1800,
      instructions: ANALYSIS_INSTRUCTIONS,
      input: `Описание сотрудника (учебные данные):\n${description}\n\nСуществующие Skills (ID и названия):\n${JSON.stringify(existingSkills)}`,
      text: { format: { type: 'json_schema', name: 'skill_analysis', strict: true, schema: SKILL_ANALYSIS_SCHEMA } }
    });
    if (response.status !== 'completed') throw Object.assign(new Error('Incomplete model response.'), { code:'MODEL_INCOMPLETE' });
    const refusal = response.output.flatMap(item=>item.content||[]).find(part=>part.type==='refusal');
    if (refusal) throw Object.assign(new Error('Model refusal.'), { code:'MODEL_REFUSAL' });
    if (!response.output_text) throw new Error('Модель не вернула структурированный ответ.');
    return JSON.parse(response.output_text);
  }
  async respondWithTools(messages, approvedSkills, executeTool, beforeRequest) {
    const tools = TOOLS;
    let input = [
      { role: 'user', content: `Подтверждённые демо Skills:\n${JSON.stringify(approvedSkills)}` },
      ...messages.slice(-12).map(m=>({ role:m.role, content:m.content }))
    ];
    const operations = [];
    for (let turn = 0; turn < 4; turn++) {
      if (!beforeRequest()) return { text: 'Достигнут дневной лимит AI-запросов. Вычисленная операция сохранена; отправьте сообщение позже, чтобы получить пояснение.', operations };
      const response = await this.client.responses.create({
        model: this.model, store: false, max_output_tokens: 800,
        instructions: TWIN_INSTRUCTIONS, input, tools, parallel_tool_calls: false
      });
      if (response.status !== 'completed') throw Object.assign(new Error('Incomplete model response.'), { code:'MODEL_INCOMPLETE' });
      const calls = response.output.filter(item => item.type === 'function_call');
      if (!calls.length) return { text: response.output_text || 'Не удалось сформировать ответ.', operations };
      input.push(...response.output);
      for (const call of calls) {
        let result;
        try {
          const args = JSON.parse(call.arguments);
          result = await executeTool(call.name, args, approvedSkills);
          if (result?.ok === true) operations.push({ name:call.name, result });
        } catch (error) {
          result = { ok: false, error: error.message || 'Не удалось выполнить функцию.' };
        }
        input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
      }
    }
    return { text: 'Выполнено несколько операций, но для безопасности остановил цепочку. Проверьте результат и продолжите отдельным сообщением.', operations };
  }
}
