export interface Chat {
  id: string;
  title: string;
  contextSources: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ToolTrace {
  name: string;
  args: unknown;
  ok?: boolean;
  summary?: string;
  error?: string;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  role: "user" | "assistant" | "system";
  content: string | null;
  openFiles: string[];
  toolCalls?: ToolTrace[];
  costTokens: number | null;
  createdAt: number;
}

export interface ChatRequest {
  chatId: string;
  message: string;
  openFiles?: string[];
  activeDocumentId?: string;
  opener?: boolean;
  retry?: boolean;
}

export interface GuiOption {
  short: string;
  prompt: string;
}

export type GuiEvent =
  | { kind: "doc_open"; sourceId: string }
  | { kind: "p_open"; documentId: string }
  | { kind: "source_edited"; sourceId: string }
  | { kind: "suggest_replies"; options: GuiOption[] }
  | { kind: "action"; action: "warn" | "celebrate" | "info"; text: string };
