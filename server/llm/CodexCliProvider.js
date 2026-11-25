import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LLMProvider } from './LLMProvider.js';
import { OFFER_REVIEW_SCHEMA, SKILL_ANALYSIS_SCHEMA } from './schemas.js';
import { ANALYSIS_INSTRUCTIONS, OFFER_REVIEW_INSTRUCTIONS, TWIN_INSTRUCTIONS } from './prompts.js';
import { TOOLS } from '../skills/tools.js';

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    text: { type: 'string' },
    tool: { type: 'string', enum: ['none', ...TOOLS.map(tool => tool.name)] },
    skillId: { type: 'string' },
    argumentsJson: { type: 'string' }
  },
  required: ['text', 'tool', 'skillId', 'argumentsJson']
};
const REPLY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { text: { type: 'string' } }, required: ['text']
};
const MAX_OUTPUT = 64 * 1024;

function findCodex() {
  if (process.env.CODEX_CLI_PATH) return process.env.CODEX_CLI_PATH;
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  const candidates = process.platform === 'win32' ? ['codex.cmd'] : ['codex'];
  for (const candidate of candidates) {
    const found = spawnSync(command, [candidate], { encoding: 'utf8', windowsHide: true });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim().split(/\r?\n/)[0].trim();
  }
  return null;
}

export class CodexCliProvider extends LLMProvider {
  constructor() {
    super();
    this.executable = findCodex();
    this.model = process.env.CODEX_MODEL || 'Codex CLI (модель из настройки Codex)';
    this.timeoutMs = Math.max(30_000, Number(process.env.CODEX_TIMEOUT_MS) || 120_000);
  }
  get ready() { return Boolean(this.executable); }

  async run(prompt, schema) {
    if (!this.ready) throw Object.assign(new Error('Codex CLI is not installed.'), { code: 'CODEX_NOT_FOUND' });
    const dir = await mkdtemp(path.join(os.tmpdir(), 'skillhub-codex-'));
    const schemaPath = path.join(dir, 'output-schema.json');
    const outputPath = path.join(dir, 'answer.json');
    await writeFile(schemaPath, JSON.stringify(schema), 'utf8');
    const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--output-schema', schemaPath, '--output-last-message', outputPath];
    if (process.env.CODEX_MODEL) args.push('--model', process.env.CODEX_MODEL);
    args.push('-');
    const childEnv = { ...process.env };
    // Codex authenticates with the existing local Codex login, not an API key.
    delete childEnv.OPENAI_API_KEY;
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(this.executable, args, {
          cwd: dir,
          env: childEnv,
          windowsHide: true,
          shell: process.platform === 'win32',
          timeout: this.timeoutMs,
          stdio: ['pipe', 'ignore', 'pipe']
        });
        let stderr = '';
        child.stderr.on('data', chunk => { if (stderr.length < MAX_OUTPUT) stderr += chunk.toString(); });
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve() : reject(Object.assign(new Error(stderr.slice(-2000) || `Codex CLI exited with ${code}`), { code: 'CODEX_EXEC_FAILED' })));
        child.stdin.on('error', () => {});
        child.stdin.end(prompt);
      });
      const raw = await readFile(outputPath, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === 'ETIMEDOUT') error.code = 'CODEX_TIMEOUT';
      throw error;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async analyzeWork(description, existingSkills, beforeRequest) {
    if (!beforeRequest()) throw Object.assign(new Error('Daily AI request limit reached.'), { code: 'LOCAL_DAILY_LIMIT' });
    return this.run(`${ANALYSIS_INSTRUCTIONS}\n\nОписание сотрудника (только учебный текст):\n${description}\n\nСуществующие Skills (ID и названия):\n${JSON.stringify(existingSkills)}`, SKILL_ANALYSIS_SCHEMA);
  }

  async reviewCommercialOffers(requirements, documents, skillContext, beforeRequest) {
    if (!beforeRequest()) throw Object.assign(new Error('Daily AI request limit reached.'), { code: 'LOCAL_DAILY_LIMIT' });
    return this.run(`${OFFER_REVIEW_INSTRUCTIONS}\n\nПодтверждённый навык сотрудника:\n${JSON.stringify(skillContext)}\n\nТребования учебной закупки:\n${JSON.stringify(requirements)}\n\nТекст учебных предложений (каждый объект — отдельный файл):\n${JSON.stringify(documents)}`, OFFER_REVIEW_SCHEMA);
  }

  async respondWithTools(messages, approvedSkills, executeTool, beforeRequest) {
    if (!beforeRequest()) return { text: 'Достигнут дневной лимит AI-запросов.', operations: [] };
    const actionPlan = await this.run(`${TWIN_INSTRUCTIONS}\n\nВыбери действие только из перечня функций приложения ниже. Если не хватает входных данных, верни tool="none" и задай вопрос в поле text. Для вызова функции все аргументы должны быть дословно выведены из сообщений пользователя; не додумывай. Верни аргументы функции в argumentsJson как JSON-объект без поля skillId (его верни отдельно).\n\nДоступные функции и схемы:\n${JSON.stringify(TOOLS)}\n\nПодтверждённые демонстрационные Skills:\n${JSON.stringify(approvedSkills)}\n\nДиалог:\n${messages.slice(-12).map(m => `${m.role}: ${m.content}`).join('\n')}`, PLAN_SCHEMA);
    if (actionPlan.tool === 'none') return { text: actionPlan.text, operations: [] };

    const tool = TOOLS.find(item => item.name === actionPlan.tool);
    const skillKindByTool = {
      validate_purchase_request: 'purchase_check',
      compare_commercial_offers: 'offer_compare',
      create_supplier_comparison: 'supplier_table'
    };
    const requiredKind = skillKindByTool[actionPlan.tool];
    if (!tool || !requiredKind) return { text: 'Действие не выполнено: выбранная функция недоступна.', operations: [] };
    const eligibleSkills = approvedSkills.filter(item => item.kind === requiredKind && item.approved === true && item.demo === true);
    const skill = eligibleSkills.find(item => item.id === actionPlan.skillId) || eligibleSkills[0];
    if (!skill) return { text: 'Действие не выполнено: для этой функции нет подтверждённого демонстрационного навыка.', operations: [] };
    let args;
    try { args = JSON.parse(actionPlan.argumentsJson); }
    catch { return { text: 'Действие не выполнено: не удалось прочитать данные операции. Уточните запрос.', operations: [] }; }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return { text: 'Действие не выполнено: неверный формат данных.', operations: [] };
    let result;
    try { result = await executeTool(actionPlan.tool, { ...args, skillId: skill.id }, approvedSkills); }
    catch (error) { return { text: error.message || 'Не удалось выполнить локальную функцию.', operations: [] }; }
    if (result?.ok !== true) return { text: 'Локальная функция не подтвердила выполнение операции.', operations: [] };
    const operations = [{ name: actionPlan.tool, result }];

    if (!beforeRequest()) return { text: actionPlan.text || 'Операция действительно выполнена локальной функцией приложения.', operations };
    try {
      const reply = await this.run(`${TWIN_INSTRUCTIONS}\n\nСформулируй короткий ответ по-русски, опираясь только на результат выполненной локальной функции. Не утверждай, что выполнялись действия вне приложения.\n\nЗапрос сотрудника:\n${messages.at(-1)?.content || ''}\n\nРезультат функции (данные приложения):\n${JSON.stringify(result)}`, REPLY_SCHEMA);
      return { text: reply.text, operations };
    } catch {
      return { text: actionPlan.text || 'Операция выполнена локальной функцией приложения. Результат операции доступен ниже.', operations };
    }
  }
}
