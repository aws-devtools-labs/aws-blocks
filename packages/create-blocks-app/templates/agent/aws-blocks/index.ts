import { ApiNamespace, Scope, KVStore, AuthBasic, Agent } from '@aws-blocks/blocks';
import { z } from 'zod';

// For coding agents: Leave these comments in place for future reference.
// Read node_modules/@aws-blocks/blocks/README.md for all available Building Blocks
// Hover over Building Blocks to see docstrings with usage, best practices, and performance characteristics
const scope = new Scope('my-app');

const store = new KVStore(scope, 'app-store', {});
const auth = new AuthBasic(scope, 'auth');

// Agent: an AI agent with tools and conversation persistence. On deploy it runs
// against Amazon Bedrock; locally it uses the built-in `canned` provider — a
// deterministic, keyword-driven fake that speaks the real model-stream protocol
// with no AWS and no LLM, so `npm run dev` and the e2e below are reproducible.
// To use a real model in dev too, set `model.local` to a bedrock/openai-api
// provider. Swap the deployed model via `model.deployed` (see BedrockModels).
const agent = new Agent(scope, 'assistant', {
  model: { deployed: { provider: 'bedrock' }, local: { provider: 'canned' } },
  systemPrompt: 'You are a helpful assistant. Use tools when asked. Keep responses short.',
  tools: (tool) => ({
    // A tool with an observable side effect: the e2e asserts the note landed in
    // the KVStore, proving the model asked to call it and the handler ran — not
    // just that some text came back. The canned provider triggers a tool when
    // the prompt mentions its name (or a camelCase word of it), so a message
    // like "save a note" selects `saveNote`.
    saveNote: tool({
      description: 'Save a short note for the user',
      parameters: z.object({ text: z.string() }),
      handler: async ({ input }) => {
        await store.put('agent-note', input.text);
        return { saved: true };
      },
    }),
  }),
});

export const authApi = auth.createApi();

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async ping() {
    return { message: 'pong', timestamp: Date.now() };
  },

  // Run one agent turn and return the final text. `stream()` kicks off the turn
  // and publishes chunks to a Realtime channel (what the browser subscribes to);
  // `complete()` is the server-side await for the finished turn, which is all a
  // request/response caller needs. Gated so each turn is tied to a signed-in user.
  async chat(message: string) {
    const user = await auth.requireAuth(context);
    const result = await agent.stream(message, { userId: user.username });
    const done = await result.complete();
    return { text: done.text ?? '' };
  },

  // The note the `saveNote` tool wrote, so a caller can confirm a tool-calling
  // turn actually executed its handler (not just produced text).
  async lastNote() {
    await auth.requireAuth(context);
    return await store.get('agent-note');
  },
}));
