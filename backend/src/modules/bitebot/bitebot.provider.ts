/*
 * BiteBot AI provider layer.
 *
 * Follows the same pattern as ComboAdvisor in surprise.ai.ts:
 *   - A narrow interface so tests can inject a stub.
 *   - A real Claude implementation that calls the Anthropic API via native fetch.
 *   - A factory that reads the API key from the environment and returns null when
 *     the key is absent, so the chat endpoint degrades gracefully without a key.
 *
 * The API key is NEVER logged, echoed, or sent to the browser.
 */

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatProvider {
  readonly name: string;
  /**
   * Sends the conversation to the provider and returns the assistant's text reply.
   * Must honour the abort signal for timeout enforcement.
   */
  complete(
    messages: ChatMessage[],
    systemPrompt: string,
    signal: AbortSignal,
  ): Promise<string>;
}

// ─── Claude (Anthropic) implementation ───────────────────────────────────────

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// Haiku is the fastest and cheapest model — appropriate for a high-traffic chat endpoint.
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 500;

function claudeProvider(apiKey: string): ChatProvider {
  return {
    name: 'claude-haiku',
    async complete(messages, systemPrompt, signal) {
      let response: Response;
      try {
        response = await fetch(ANTHROPIC_API_URL, {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system: systemPrompt,
            messages,
          }),
        });
      } catch (err) {
        // Network error or aborted
        throw new Error(
          err instanceof Error && err.name === 'AbortError'
            ? 'provider_timeout'
            : 'provider_unavailable',
          { cause: err },
        );
      }

      if (!response.ok) {
        // Log status only; never log the body which may echo the key back on auth errors.
        throw new Error(`provider_http_${response.status}`);
      }

      const data = (await response.json()) as {
        content?: { type: string; text: string }[];
      };
      const text = data?.content?.find((c) => c.type === 'text')?.text;
      if (!text?.trim()) throw new Error('provider_empty_response');
      return text.trim();
    },
  };
}

/**
 * Returns a configured provider when ANTHROPIC_API_KEY is set, null otherwise.
 * Call once at startup and pass the result through AppDependencies.
 */
export function bitebotProviderFor(apiKey: string | undefined): ChatProvider | null {
  if (!apiKey) return null;
  return claudeProvider(apiKey);
}
