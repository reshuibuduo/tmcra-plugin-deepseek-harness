export interface MemoryCapture { key: string; sessionId: string; mode: string; generation: number; parentGeneration?: number | null; turnHash?: string | null; parentTurnHash?: string | null; read: boolean; write: boolean }
export function beginMemoryTurn(key: string, sessionId: string, turnId: string): Promise<MemoryCapture>;
export function suppressMemoryTurn(key: string, sessionId: string): Promise<unknown>;
export function controlKey(config: {apiKey: string; baseUrl: string}, scope: string): string;
export function memoryPolicy(key: string, sessionId: string): Promise<MemoryCapture>;
export function mayWrite(capture: MemoryCapture): Promise<boolean>;
export function legacyWriteAllowed(key: string, args: {sessionId?: string; sessionHash?: string}): Promise<boolean>;
export function setMemoryMode(key: string, sessionId: string, mode: string): Promise<unknown>;
export function memoryDashboard(key: string, sessionId: string): Promise<{budgetChars: number; tasks: any[]; recent: any[]; policy: MemoryCapture}>;
export function taskContext(key: string, sessionId: string, prompt: string, options?: {capture?: MemoryCapture}): Promise<{query: string; task: any; candidates: any[]}>;
export function budgetEvidence(layers: {scope: string; content: string}[], options?: {budgetChars?: number; visibleText?: string}): {content: string; included: any[]; omitted: any[]; characters: number; estimatedTokens: number};
export function recordMemoryActivity(capture: MemoryCapture, activity: Record<string, unknown>): Promise<void>;
export function finishObservedTurn(capture: MemoryCapture, prompt: string, answer: string): Promise<unknown>;
export function updateTask(key: string, sessionId: string, args: Record<string, unknown>): Promise<unknown>;
