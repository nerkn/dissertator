import type {
  AiFunction,
  BindingSetResult,
  Bindings,
  FunctionTestResult,
  ModelsResponse,
  ProviderRow,
  ResolvedBindings,
} from "@dissertator/shared";
import { req } from "./_client";

export const providersApi = {
  // --- Providers (P6) ------------------------------------------------------
  // Named, user-editable provider rows. The frontend builds the list; the
  // Functions tab assigns chat-kind → chat, embedding-kind → vectorizer.
  // Keys live in the OS keychain under each row's keyUser (frontend-managed).

  listProviders: () => req<ProviderRow[]>("/providers"),
  createProvider: (input: {
    name: string;
    /** Backend flavor / branding (free text — engine is OpenAI-style). */
    type: string;
    apiUrl?: string;
    isDefault?: boolean;
  }) =>
    req<ProviderRow>("/providers", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateProvider: (
    id: string,
    patch: {
      name?: string;
      type?: string;
      apiUrl?: string;
      isDefault?: boolean;
    },
  ) =>
    req<ProviderRow>(`/providers/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  deleteProvider: (id: string) =>
    req<{ ok: true }>(`/providers/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  // --- Bindings (P-multi): function ↔ provider+model matrix --------------
  // The Functions tab edits these; `setBinding` returns `revectorized` when
  // an embed change resets all chunks (the UI warns before sending).

  getBindings: () =>
    req<{ bindings: Bindings; resolved: ResolvedBindings }>("/bindings"),
  setBinding: (fn: AiFunction, providerId: string, model: string) =>
    req<BindingSetResult>(`/bindings/${fn}`, {
      method: "PUT",
      body: JSON.stringify({ providerId, model }),
    }),

  /** Live model list for a provider (proxies upstream /models). The key for
   *  the provider travels as a Bearer header. */
  getProviderModels: (id: string, apiKey?: string) =>
    req<ModelsResponse>(`/providers/${encodeURIComponent(id)}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    }),

  /** Per-function connectivity test (minimal real call). Bearer header. */
  testFunction: (fn: AiFunction, apiKey?: string) =>
    req<FunctionTestResult>(`/functions/${fn}/test`, {
      method: "POST",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    }),
};
