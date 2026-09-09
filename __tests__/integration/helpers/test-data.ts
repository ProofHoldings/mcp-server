let counter = 0;

export function uniqueEmail(prefix = 'mcp-test'): string {
  return `${prefix}-${Date.now()}-${++counter}-${Math.random().toString(36).slice(2, 6)}@proof.holdings`;
}

export function uniqueDomain(prefix = 'mcp-test'): string {
  return `${prefix}-${Date.now()}-${++counter}-${Math.random().toString(36).slice(2, 6)}.proof.holdings`;
}

export function uniqueId(prefix = 'id'): string {
  return `${prefix}_${Date.now()}_${++counter}`;
}

export function uniqueName(prefix = 'MCP Test'): string {
  return `${prefix} ${Date.now()}-${++counter}`;
}

export const NONEXISTENT_ID = '000000000000000000000000';
export const NONEXISTENT_SESSION_ID = 'sess_00000000000000000000000000000000';
export const INVALID_TOKEN = 'a'.repeat(64);
