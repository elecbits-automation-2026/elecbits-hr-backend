import { z } from '../../shared/zod.js';

/**
 * Chats are not stored, so the browser sends the conversation each time —
 * plain text turns only. Earlier tool results are never accepted back from
 * the client (a forged "result" can't be smuggled in); the model calls the
 * tool again instead.
 */
const chatTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(2000),
});

export const chatSchema = z
  .object({
    messages: z
      .array(chatTurnSchema)
      .min(1)
      .max(20)
      .refine((m) => m[0]!.role === 'user' && m[m.length - 1]!.role === 'user', {
        message: 'The conversation must start and end with a user message',
      }),
  })
  .openapi('AssistantChatInput');

/** One server-sent event; `data:` carries this JSON. */
export const assistantEventSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('tool'), name: z.string(), label: z.string() }),
    z.object({ type: z.literal('text'), delta: z.string() }),
    z.object({ type: z.literal('done'), tools: z.array(z.string()) }),
    z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
  ])
  .openapi('AssistantEvent');

export type ChatInput = z.infer<typeof chatSchema>;
export type ChatTurn = ChatInput['messages'][number];
