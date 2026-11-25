/** Typed domain contract for the demo browser store and replaceable API services. */
export type Id = string;
export type SkillStatus = 'Черновик' | 'Подтверждён сотрудником · демо' | 'На проверке' | 'Утверждён';
export type DemoCapability = 'purchase_check' | 'offer_compare' | 'supplier_table';

export interface Department { id: Id; name: string; parentId?: Id }
export interface Employee { id: Id; name: string; role: string; departmentId: Id; experienceYears?: number }
export interface Task { id: Id; employeeId: Id; title: string; description: string; cadence?: string; status: string }
export interface DigitalTwin { employeeId: Id; taskIds: Id[]; skillIds: Id[]; completion: number; updatedAt: string }
export interface Evidence { statement: string; evidence: string; needsValidation: boolean }
export interface Skill {
  id: Id; taskId?: Id; kind?: DemoCapability; title: string; purpose: string;
  inputs: Evidence[] | string[]; steps: Evidence[] | string[]; decisions: Evidence[] | string[];
  exceptions: Evidence[] | string[]; tools: Evidence[] | string[]; expectedResult: Evidence | string;
  allowedAutomation: Evidence[] | string[]; sources: string[]; unknowns: string[];
  status: SkillStatus; author: string; version: string; approved: boolean; demo: boolean;
  updatedAt: string; history: SkillVersion[];
}
export interface SkillVersion { version: string; date: string; change: string; snapshot?: Partial<Skill> }
export interface SkillExecution { id: Id; skillId: Id; employeeId: Id; input: unknown; status: string; result: unknown; createdAt: string }
export interface Feedback { id: Id; skillId: Id; authorId: Id; rating?: string; comment: string; createdAt: string }
export interface OperationRequest { operation: string; payload: Record<string, unknown>; requestedBy: Id }
export interface OperationResult { accepted: boolean; operationId?: Id; message: string; requiresHumanApproval: boolean }
export interface Approval { skillId: Id; employeeId: Id; status: 'confirmed_demo' | 'pending' | 'rejected'; date: string; note: string }

export interface SkillAnalysis {
  summary: string;
  clarificationQuestions: string[];
  skills: Array<{
    title: string; purpose: string; existingSkillId: string;
    inputs: Evidence[]; steps: Evidence[]; decisions: Evidence[]; exceptions: Evidence[];
    tools: Evidence[]; expectedResult: Evidence; allowedAutomation: Evidence[];
    sources: string[]; unknowns: string[];
  }>;
}
export interface AssistantOperation { name: string; result: unknown }
export interface AssistantResponse { text: string; operations: AssistantOperation[] }

/** Provider contract used by routes; Codex CLI and OpenAI API providers implement it. */
export interface LLMProvider {
  readonly ready: boolean;
  analyzeWork(description: string, existingSkills: Pick<Skill,'id'|'title'>[], beforeRequest: () => boolean): Promise<SkillAnalysis>;
  respondWithTools(messages: Array<{role:'user'|'assistant';content:string}>, approvedSkills: Skill[], executeTool: (name:string,args:unknown,skills:Skill[])=>Promise<unknown>, beforeRequest:()=>boolean): Promise<AssistantResponse>;
}

/** Future corporate adapters. No adapter is connected in the demo. */
export interface CorporateSystemAdapter {
  executeOperation(operation: OperationRequest): Promise<OperationResult>;
}
