export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ToolSchema { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface ChatResponse { message: ChatMessage; tokens: number; finishReason: string | null }

/** A model that can chat with tools. Backends: local (OpenAI-compatible), later anthropic-api, claude-code. */
export interface ModelBackend {
  readonly model: string;
  chat(messages: ChatMessage[], tools: ToolSchema[], signal: AbortSignal): Promise<ChatResponse>;
}
