import type { Server } from "node:http";
export function localSetupAction(action: string): Promise<unknown>;
export function createMemoryActions(options: { config: {apiKey: string; baseUrl: string}; scope: string; sessionId: string; globalScope?: string;
  request: (path: string, options: {method: string; headers: Record<string, string>; body?: unknown}) => Promise<any>; status?: () => Promise<unknown>;
  confirmFeedback?: (message: string, preview: unknown) => Promise<string>;
}): (action: string, args?: Record<string, unknown>) => Promise<unknown>;
export function startMemoryCenter(options: {invoke: (action: string, args?: Record<string, unknown>) => Promise<unknown>; open?: boolean}): Promise<{server: Server; url: string}>;
