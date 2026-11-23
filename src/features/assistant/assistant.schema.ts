import { z } from '../../shared/zod.js';
import { QUICK_QUESTIONS } from './assistant.quick.js';

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
    // Phase 2: an action the user must confirm — Confirm posts `payload` to
    // `endpoint` (an existing route) with the user's own session.
    z.object({
      type: z.literal('proposal'),
      id: z.string().uuid(),
      action: z.enum(['add_goal', 'assign_training', 'nominate', 'raise_opening']),
      title: z.string(),
      lines: z.array(z.string()),
      endpoint: z.string(),
      payload: z.record(z.string(), z.unknown()),
      link: z.string(),
      linkLabel: z.string(),
    }),
    // Phase 2: a draft shown with a Copy button — never stored.
    z.object({
      type: z.literal('note'),
      id: z.string().uuid(),
      title: z.string(),
      kind: z.string(),
      content: z.string(),
    }),
  ])
  .openapi('AssistantEvent');

/** The offline buttons: one whitelisted read, no model. */
export const quickSchema = z
  .object({ question: z.enum(QUICK_QUESTIONS) })
  .strict()
  .openapi('AssistantQuickInput');

export const quickResultSchema = z
  .object({
    question: z.enum(QUICK_QUESTIONS),
    label: z.string(),
    /** Which read answered (team or org view, by the caller's access). */
    tool: z.string(),
    /** Plain text, ready to show. */
    text: z.string(),
  })
  .openapi('AssistantQuickResult');

export type ChatInput = z.infer<typeof chatSchema>;
export type QuickInput = z.infer<typeof quickSchema>;
export type ChatTurn = ChatInput['messages'][number];
