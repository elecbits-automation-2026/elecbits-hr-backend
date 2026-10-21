import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

export interface ScoreResult {
  score: number;
  feedback: string;
  kpiHits: string[];
}

interface GoalContext {
  title: string;
  metric: string | null;
  target: string | null;
  progress: number;
}

const PROMPT_RULES = `You score one day's work update against the person's own quarterly goals.
Be fair but not generous. An honest account of a mistake, a blocker or a hard
debugging day should score WELL — honesty is the point, theater is not.
Vague filler ("worked on stuff") scores low. Reply with ONLY a JSON object:
{"score": <0-100 integer>, "feedback": "<one or two plain sentences, speaking to the person>", "kpiHits": ["<goal titles this day moved, if any>"]}`;

/**
 * Score a work update against the person's OWN goals via the Anthropic API.
 * Returns null when scoring is off (no key), the call fails, times out, or
 * the reply doesn't parse — the caller stores NULL ("unscored"), never 0:
 * an outage must not create a bad performance record (load-bearing rule).
 */
export const scoreUpdate = async (
  note: string,
  goals: GoalContext[],
): Promise<ScoreResult | null> => {
  if (!env.ai.anthropicApiKey) return null;
  try {
    const goalLines =
      goals.length > 0
        ? goals
            .map(
              (g) =>
                `- ${g.title}${g.metric ? ` (metric: ${g.metric})` : ''}${g.target ? ` (target: ${g.target})` : ''} — currently ${g.progress}%`,
            )
            .join('\n')
        : '(no goals set yet — score general usefulness and clarity)';
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ai.anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: env.ai.model,
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: `${PROMPT_RULES}\n\nTheir goals this quarter:\n${goalLines}\n\nToday's update:\n${note}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'work-update scoring call failed');
      return null;
    }
    const body = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = body.content?.find((c) => c.type === 'text')?.text ?? '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as {
      score?: unknown;
      feedback?: unknown;
      kpiHits?: unknown;
    };
    const score = Number(parsed.score);
    if (!Number.isFinite(score)) return null;
    return {
      score: Math.max(0, Math.min(100, Math.round(score))),
      feedback: typeof parsed.feedback === 'string' ? parsed.feedback.slice(0, 1000) : '',
      kpiHits: Array.isArray(parsed.kpiHits)
        ? parsed.kpiHits.filter((k): k is string => typeof k === 'string').slice(0, 6)
        : [],
    };
  } catch (err) {
    logger.warn({ err }, 'work-update scoring errored — storing unscored');
    return null;
  }
};

export const scoringEnabled = (): boolean => env.ai.anthropicApiKey !== null;
