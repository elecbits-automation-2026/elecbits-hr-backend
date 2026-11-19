import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody } from '../../docs/helpers.js';
import { assistantEventSchema, chatSchema } from './assistant.schema.js';

const bearer = [{ bearerAuth: [] }];
const tags = ['Assistant'];

/** OpenAPI registration for the /assistant endpoints. */
export const registerAssistantDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'post',
    path: '/api/v1/assistant/chat',
    tags,
    summary:
      'HR Assistant: send the conversation (text turns, ending with the user), get the answer streamed as server-sent events. HR and managers only; read-only tools scoped to the caller; chats are not stored',
    security: bearer,
    request: { body: jsonBody(chatSchema) },
    responses: {
      200: {
        description:
          'text/event-stream — each `data:` line is one AssistantEvent: tool (a tool ran), text (answer delta), done (with the tools used) or error',
        content: { 'text/event-stream': { schema: assistantEventSchema } },
      },
      403: errorResponse('ASSISTANT_OFF (Admin switch), ASSISTANT_NOT_ALLOWED (not HR or a manager)'),
      429: errorResponse(`ASSISTANT_LIMIT — the daily message cap`),
      503: errorResponse('ASSISTANT_NOT_CONFIGURED — no Anthropic API key on the server'),
    },
  });
};
