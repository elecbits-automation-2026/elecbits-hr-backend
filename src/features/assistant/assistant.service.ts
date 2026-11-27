import Anthropic from '@anthropic-ai/sdk';
import createError from 'http-errors';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { hasOrgScope } from '../../shared/helpers/helpers.js';
import type { AuthzRepository, ResolvedAccess } from '../access/authz.repository.js';
import type { SettingsReader } from '../settings/index.js';
import { ACTION_TOOLS, isCardResult, type AssistantCard } from './assistant.actions.js';
import { FALLBACK_REPLY, SYSTEM_PROMPT, requestContext } from './assistant.prompt.js';
import {
  QUICK_LABEL,
  QUICK_TOOLS,
  quickText,
  type QuickQuestion,
} from './assistant.quick.js';
import type { AssistantRepository } from './assistant.repository.js';
import type { ChatTurn } from './assistant.schema.js';
import {
  TOOLS,
  type AnyTool,
  type Caller,
  type ToolServices,
} from './assistant.tools.js';

/** Messages per user per day (design: a hard ceiling on cost). */
export const DAILY_MESSAGE_LIMIT = 40;
/** Read tools and the propose-only action tools, as the model sees them. */
const ALL_TOOLS = [...TOOLS, ...ACTION_TOOLS];
/** Model round trips per message — a confused loop stops here. */
const MAX_STEPS = 6;

/** What the controller streams to the browser. */
export type AssistantEvent =
  | { type: 'tool'; name: string; label: string }
  | { type: 'text'; delta: string }
  | { type: 'done'; tools: string[] }
  | { type: 'error'; code: string; message: string }
  // Phase 2: a proposal to confirm, or a draft note (see assistant.actions.ts).
  | AssistantCard;

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
 * The HR Assistant (phase 2). The model never reaches the database: it asks
 * for tools, each a service call made as the signed-in user. Action tools
 * only PROPOSE — the user confirms on a card, which calls the existing
 * endpoint with their own session. Chats are not stored — the browser sends the text turns each time
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

  const callerOf = async (
    userId: string,
    employeeId: string,
  ): Promise<AssistantCaller> => {
    const [manager, people, attendance, policies, peopleWrite, deptHead, name] =
      await Promise.all([
        repo.hasReports(employeeId),
        authz.resolveAccess(employeeId, 'hrbp.people', 'read'),
        authz.resolveAccess(employeeId, 'hrbp.attendance', 'read'),
        authz.resolveAccess(employeeId, 'hrbp.policies', 'read'),
        authz.resolveAccess(employeeId, 'hrbp.people', 'update'),
        repo.isDeptHead(employeeId),
        repo.employeeName(employeeId),
      ]);
    const [hrPeople, hrAttendance, hrPeopleWrite] = await Promise.all([
      hrReach(employeeId, people),
      hrReach(employeeId, attendance),
      hrReach(employeeId, peopleWrite),
    ]);
    const caller: Caller = {
      userId,
      employeeId,
      manager,
      hrPeople,
      hrPeopleOrg: people.bypass || people.scopes.includes('org'),
      hrAttendance,
      hrPoliciesOrg: hasOrgScope(policies),
      hrPeopleWrite,
      hrPeopleWriteOrg: hasOrgScope(peopleWrite),
      deptHead,
    };
    const roles = [
      ...(manager ? ['manager'] : []),
      ...(hrPeople || hrAttendance || hasOrgScope(policies) ? ['HR'] : []),
    ];
    return { ...caller, name: name ?? 'Unknown', roles };
  };

  /**
   * Everything that can refuse, checked before the stream opens so refusals
   * answer as ordinary JSON errors: the Admin switch, the server key, the
   * caller being HR or a manager, and the daily cap.
   */
  const requireOn = async (): Promise<void> => {
    const { enabled } = await settings.effective('assistant.enabled');
    if (!enabled) {
      throw createError(403, 'The HR Assistant is switched off', {
        code: 'ASSISTANT_OFF',
      });
    }
  };

  const allowedCaller = async (
    userId: string,
    employeeId: string,
  ): Promise<AssistantCaller> => {
    const caller = await callerOf(userId, employeeId);
    if (caller.roles.length === 0) {
      throw createError(403, 'The HR Assistant is for HR and managers', {
        code: 'ASSISTANT_NOT_ALLOWED',
      });
    }
    return caller;
  };

  /**
   * Whether the caller would get past the gate's "who" checks: the Admin
   * switch is on and they are HR or a manager by the same rule as the gate.
   * Lets the shell show the Assistant button only to people it will answer.
   */
  const access = async (
    userId: string,
    employeeId: string,
  ): Promise<{ allowed: boolean }> => {
    const { enabled } = await settings.effective('assistant.enabled');
    if (!enabled) return { allowed: false };
    const caller = await callerOf(userId, employeeId);
    return { allowed: caller.roles.length > 0 };
  };

  const gate = async (userId: string, employeeId: string): Promise<AssistantCaller> => {
    await requireOn();
    // Who may use it comes first: a plain employee gets the 403, not a 503
    // about server setup that is none of their business.
    const caller = await allowedCaller(userId, employeeId);
    if (!client) {
      // `expose`: a deliberate 5xx whose message is safe and actionable.
      throw createError(503, 'The HR Assistant is not set up on the server', {
        code: 'ASSISTANT_NOT_CONFIGURED',
        expose: true,
      });
    }
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    if ((await repo.messagesSince(userId, since)) >= DAILY_MESSAGE_LIMIT) {
      throw createError(
        429,
        `You've used today's ${DAILY_MESSAGE_LIMIT} assistant messages`,
        {
          code: 'ASSISTANT_LIMIT',
        },
      );
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
    await repo.logToolCall(
      caller.userId,
      caller.employeeId,
      t.name,
      t.audit ? t.audit(parsed.data) : parsed.data,
    );
    try {
      const result = await t.run(caller, parsed.data, services);
      if (isCardResult(result)) {
        // A proposal / draft goes to the drawer; the model only hears that it was shown.
        emit(result.card);
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result.forModel),
        };
      }
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      };
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
    const tools = ALL_TOOLS.filter((t) => t.allowed(caller)).sort((a, b) =>
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
      // Server setup problems get an admin-readable message, never the generic
      // "couldn't answer" — that reads like a hard question, not a broken key.
      if (
        err instanceof Anthropic.AuthenticationError ||
        err instanceof Anthropic.PermissionDeniedError
      ) {
        logger.error(
          { status: err.status, requestId: err.requestID },
          'assistant API key rejected',
        );
        emit({
          type: 'error',
          code: 'ASSISTANT_KEY_INVALID',
          message:
            "The AI service rejected the server's API key. An admin needs to replace ANTHROPIC_API_KEY and restart the backend.",
        });
      } else if (err instanceof Anthropic.NotFoundError) {
        logger.error(
          { status: err.status, requestId: err.requestID, model: env.ai.assistantModel },
          'assistant model unavailable',
        );
        emit({
          type: 'error',
          code: 'ASSISTANT_MODEL_UNAVAILABLE',
          message:
            "The configured AI model isn't available to this API key. An admin needs to check ANTHROPIC_ASSISTANT_MODEL.",
        });
      } else if (err instanceof Anthropic.RateLimitError) {
        emit({
          type: 'error',
          code: 'ASSISTANT_BUSY',
          message: 'The assistant is busy right now — try again in a minute.',
        });
      } else if (err instanceof Anthropic.APIError) {
        logger.warn(
          { status: err.status, requestId: err.requestID },
          'assistant API error',
        );
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

  /**
   * The offline buttons: the same access gating as chat minus the server key
   * (and the daily cap — no model is called), then ONE whitelisted read tool
   * run directly, written out as plain text.
   */
  const quick = async (
    userId: string,
    employeeId: string,
    question: QuickQuestion,
  ): Promise<{ question: QuickQuestion; label: string; tool: string; text: string }> => {
    await requireOn();
    const caller = await allowedCaller(userId, employeeId);
    const t = QUICK_TOOLS[question]
      .map((name) => TOOLS.find((x) => x.name === name)!)
      .find((x) => x.allowed(caller));
    if (!t) {
      throw createError(403, 'This quick answer is not available with your access', {
        code: 'ASSISTANT_QUICK_NOT_ALLOWED',
      });
    }
    const input = t.input.parse({});
    await repo.logToolCall(userId, employeeId, t.name, { quick: true });
    const result = await t.run(caller, input, services);
    return {
      question,
      label: QUICK_LABEL[question],
      tool: t.label,
      text: quickText(t.name, result),
    };
  };

  return { access, gate, chat, quick };
};

export type AssistantService = ReturnType<typeof createAssistantService>;

/** One client per process; null without a key (the gate answers 503). */
export const assistantClient: Anthropic | null = env.ai.anthropicApiKey
  ? new Anthropic({ apiKey: env.ai.anthropicApiKey, maxRetries: 2, timeout: 120_000 })
  : null;
