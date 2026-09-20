/** 统一 Tool 返回结构（附录 A） */
export interface ToolResult<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
  suggestedNextOperation?: string;
}

export const ErrorCodes = {
  ONBOARDING_REQUIRED: 'ONBOARDING_REQUIRED',
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  REPLAN_REQUIRED: 'REPLAN_REQUIRED',
  INVALID_STATE: 'INVALID_STATE',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  INTERNAL: 'INTERNAL',
} as const;

export function ok<T>(data: T, suggestedNextOperation?: string): ToolResult<T> {
  return { ok: true, data, ...(suggestedNextOperation ? { suggestedNextOperation } : {}) };
}

export function err(code: string, message: string, retryable = false): ToolResult<never> {
  return { ok: false, error: { code, message, retryable } };
}

/** Core 层业务错误：携带错误码，可被 MCP/API 层转换为 ToolResult */
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
