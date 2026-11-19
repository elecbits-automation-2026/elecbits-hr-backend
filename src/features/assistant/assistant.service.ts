import Anthropic from '@anthropic-ai/sdk';
import createError from 'http-errors';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import type { AuthzRepository, ResolvedAccess } from '../access/authz.repository.js';
import type { SettingsReader } from '../settings/index.js';
import { FALLBACK_REPLY, SYSTEM_PROMPT, requestContext } from './assistant.prompt.js';
import type { AssistantRepository } from './assistant.repository.js';
import type { ChatTurn } from './assistant.schema.js';
import { TOOLS, type AnyTool, type Caller, type ToolServices } from './assistant.tools.js';

/** Messages per user per day (design: a hard ceiling on cost). */
export const DAILY_MESSAGE_LIMIT = 40;
/** Model round trips per message — a confused loop stops here. */
const MAX_STEPS = 6;

/** What the controller streams to the browser. */
export type AssistantEvent =
  | { type: 'tool'; name: string; label: string }
  | { type: 'text'; delta: string }
  | { type: 'done'; tools: string[] }
  | { type: 'error'; code: string; message: string };

export interface AssistantCaller extends Caller {
  name: string;
  roles: string[];
}

/** JSON schema for a tool input, without the $schema key the API doesn't need. */
const inputSchemaOf = (input: z.ZodObject): Anthropic.Beta.BetaTool.InputSchema => {
  const { $schema: _drop, ...schema } = z.toJSONSchema(input, { io: 'input' }) as Record<
    string,
    unknown
  >;
  return { ...schema, type: 'object' } as Anthropic.Beta.BetaTool.InputSchema;
};

/**
 * The HR Assistant (phase 1, read-only). The model never reaches the
 * database: it asks for tools, each a service call made as the signed-in
 * user. Chats are not stored — the browser sends the text turns each time
 * and earlier tool results are never accepted back from it.
 */
export const createAssistantService = (deps: {
  repo: AssistantRepository;
  authz: AuthzRepository;
  settings: SettingsReader;
  services: ToolServices;
  client: Anthropic | null;
}) => {
  const { repo, authz, settings, services, client } = deps;

  /** A grant that reaches nobody but the holder is not an HR view. */
  const hrReach = async (employeeId: string, access: ResolvedAccess) => {
    if (!access.bypass && access.scopes.length === 0) return null;
    const scope = await authz.reachable(employeeId, access);
    return !scope.all && scope.ids.size <= 1 ? null : scope;
  };

  const callerOf = async (userId: string, employeeId: string): Promise<AssistantCaller> => {
    const [manager, people, attendance, name] = await Promise.all([
      repo.hasReports(employeeId),
      authz.resolveAccess(employeeId, 'hrbp.people', 'read'),
      authz.resolveAccess(employeeId, 'hrbp.attendance', 'read'),
      repo.employeeName(employeeId),
    ]);
    const [hrPeople, hrAttendance] = await Promise.all([
      hrReach(employeeId, people),
      hrReach(employeeId, attendance),
    ]);
    const caller: Caller = {
      userId,
      employeeId,
      manager,
      hrPeople,
      hrPeopleOrg: people.bypass || people.scopes.includes('org'),
      hrAttendance,
    };
    const roles = [
      ...(manager ? ['manager'] : []),
      ...(hrPeople || hrAttendance ? ['HR'] : []),
    ];
    return { ...caller, name: name ?? 'Unknown', roles };
  };

  /**
   * Everything that can refuse, checked before the stream opens so refusals
   * answer as ordinary JSON errors: the Admin switch, the server key, the
   * caller being HR or a manager, and the daily cap.
   */
  const gate = async (userId: string, employeeId: string): Promise<AssistantCaller> => {
    const { enabled } = await settings.effective('assistant.enabled');
    if (!enabled) {
      throw createError(403, 'The HR Assistant is switched off', { code: 'ASSISTANT_OFF' });
    }
    if (!client) {
      throw createError(503, 'The HR Assistant is not set up on the server', {
        code: 'ASSISTANT_NOT_CONFIGURED',
      });
    }
    const caller = await callerOf(userId, employeeId);
    if (caller.roles.length === 0) {
      throw createError(403, 'The HR Assistant is for HR and managers', {
        code: 'ASSISTANT_NOT_ALLOWED',
      });
    }
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    if ((await repo.messagesSince(userId, since)) >= DAILY_MESSAGE_LIMIT) {
      throw createError(429, `You've used today's ${DAILY_MESSAGE_LIMIT} assistant messages`, {
        code: 'ASSISTANT_LIMIT',
      });
    }
    return caller;
  };

  /** One tool call: validate, audit, run; failures go back to the model as errors. */
  const runTool = async (
    caller: AssistantCaller,
    tools: AnyTool[],
    block: Anthropic.Beta.BetaToolUseBlock,
    emit: (e: AssistantEvent) => void,
  ): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
    const fail = (message: string): Anthropic.Beta.BetaToolResultBlockParam => ({
      type: 'tool_result',
      tool_use_id: block.id,
      is_error: true,
      content: message,
    });
    const t = tools.find((x) => x.name === block.name);
    if (!t) return fail(`Unknown tool ${block.name}`);
    const parsed = t.input.safeParse(block.input ?? {});
    if (!parsed.success) return fail(`Invalid input: ${parsed.error.message}`);

    emit({ type: 'tool', name: t.name, label: t.label });
    await repo.logToolCall(caller.userId, caller.employeeId, t.name, parsed.data);
    try {
      const result = await t.run(caller, parsed.data, services);
      return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) };
    } catch (err) {
      // An access refusal inside a service reads as "can't see", never a stack.
      const status = (err as { status?: number }).status;
      if (status === 403 || status === 404) return fail('Not available with your access');
      logger.warn({ err, tool: t.name }, 'assistant tool failed');
      return fail('The tool failed; tell the user to try again later');
    }
  };

  const chat = async (
    caller: AssistantCaller,
    history: ChatTurn[],
    emit: (e: AssistantEvent) => void,
    signal: AbortSignal,
  ): Promise<void> => {
    const tools = TOOLS.filter((t) => t.allowed(caller)).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const apiTools: Anthropic.Beta.BetaTool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: inputSchemaOf(t.input),
      eager_input_streaming: true,
    }));
    const system: Anthropic.Beta.BetaTextBlockParam[] = [
      // Breakpoint here caches tools + the fixed prompt (render order tools → system).
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      {
        type: 'text',
        text: requestContext({
          name: caller.name,
          roles: caller.roles,
          today: new Date().toLocaleDateString('en-IN', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          }),
        }),
      },
    ];
    const messages: Anthropic.Beta.BetaMessageParam[] = history.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const used = new Set<string>();

    try {
      for (let step = 0; ; step++) {
        if (step === MAX_STEPS) {
          emit({ type: 'text', delta: FALLBACK_REPLY });
          break;
        }
        const stream = client!.beta.messages.stream(
          {
            model: env.ai.assistantModel,
            max_tokens: 8000,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            output_config: { effort: 'low' },
            system,
            tools: apiTools,
            messages,
          },
          { signal },
        );
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            emit({ type: 'text', delta: event.delta.text });
          }
        }
        const message = await stream.finalMessage();
        const uses = message.content.filter(
          (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
        );
        if (message.stop_reason === 'refusal') {
          emit({ type: 'text', delta: FALLBACK_REPLY });
          break;
        }
        if (message.stop_reason === 'max_tokens' && uses.length > 0) {
          emit({ type: 'error', code: 'ASSISTANT_TRUNCATED', message: FALLBACK_REPLY });
          break;
        }
        if (message.stop_reason !== 'tool_use' || uses.length === 0) break;

        // Append-only: the reply goes back unchanged, then every result in ONE turn.
        messages.push({ role: 'assistant', content: message.content });
        const results = await Promise.all(
          uses.map((b) => runTool(caller, tools, b, emit)),
        );
        for (const b of uses) used.add(b.name);
        messages.push({ role: 'user', content: results });
      }
      emit({ type: 'done', tools: [...used] });
    } catch (err) {
      if (err instanceof Anthropic.APIUserAbortError || signal.aborted) return;
      if (err instanceof Anthropic.RateLimitError) {
        emit({
          type: 'error',
          code: 'ASSISTANT_BUSY',
          message: 'The assistant is busy right now — try again in a minute.',
        });
      } else if (err instanceof Anthropic.APIError) {
        logger.warn({ status: err.status, requestId: err.requestID }, 'assistant API error');
        emit({ type: 'error', code: 'ASSISTANT_UPSTREAM', message: FALLBACK_REPLY });
      } else {
        logger.error({ err }, 'assistant chat failed');
        emit({ type: 'error', code: 'ASSISTANT_FAILED', message: FALLBACK_REPLY });
      }
    } finally {
      // Counted even when cut short, so the daily cap can't be dodged by aborting.
      await repo.logMessage(caller.userId, caller.employeeId, [...used]).catch((err) => {
        logger.warn({ err }, 'assistant message audit failed');
      });
    }
  };

  return { gate, chat };
};

export type AssistantService = ReturnType<typeof createAssistantService>;

/** One client per process; null without a key (the gate answers 503). */
export const assistantClient: Anthropic | null = env.ai.anthropicApiKey
  ? new Anthropic({ apiKey: env.ai.anthropicApiKey, maxRetries: 2, timeout: 120_000 })
  : null;
