import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody } from '../../docs/helpers.js';
import {
  assistantEventSchema,
  chatSchema,
  quickResultSchema,
  quickSchema,
} from './assistant.schema.js';

const bearer = [{ bearerAuth: [] }];
const tags = ['Assistant'];

/** OpenAPI registration for the /assistant endpoints. */
export const registerAssistantDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'post',
    path: '/api/v1/assistant/chat',
    tags,
    summary:
      'HR Assistant: send the conversation (text turns, ending with the user), get the answer streamed as server-sent events. HR and managers only; tools scoped to the caller; action tools only propose (the drawer confirms through the existing endpoint); chats are not stored',
    security: bearer,
    request: { body: jsonBody(chatSchema) },
    responses: {
      200: {
        description:
          'text/event-stream — each `data:` line is one AssistantEvent: tool (a tool ran), text (answer delta), proposal (an action to confirm: Confirm posts `payload` to `endpoint` with the user session), note (a draft to copy; not stored), done (with the tools used) or error (ASSISTANT_KEY_INVALID, ASSISTANT_MODEL_UNAVAILABLE, ASSISTANT_BUSY, ASSISTANT_UPSTREAM, ASSISTANT_TRUNCATED, ASSISTANT_FAILED)',
        content: { 'text/event-stream': { schema: assistantEventSchema } },
      },
      403: errorResponse(
        'ASSISTANT_OFF (Admin switch), ASSISTANT_NOT_ALLOWED (not HR or a manager)',
      ),
      429: errorResponse(`ASSISTANT_LIMIT — the daily message cap`),
      503: errorResponse('ASSISTANT_NOT_CONFIGURED — no Anthropic API key on the server'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/assistant/quick',
    tags,
    summary:
      "HR Assistant offline buttons: run ONE whitelisted read (who's out today, who hasn't sent a work update, open case counts) without the model; the org view for HR, else the caller's team. Same gating as chat minus the server key and the daily cap",
    security: bearer,
    request: { body: jsonBody(quickSchema) },
    responses: {
      200: {
        description: 'The answer as plain text',
        content: { 'application/json': { schema: quickResultSchema } },
      },
      403: errorResponse(
        'ASSISTANT_OFF, ASSISTANT_NOT_ALLOWED, ASSISTANT_QUICK_NOT_ALLOWED (no tool for this question with your access)',
      ),
    },
  });
};
