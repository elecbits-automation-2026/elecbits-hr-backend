import type { Request, Response } from 'express';
import { createAuthzRepository } from '../access/authz.repository.js';
import { createAttendanceRepository } from '../attendance/attendance.repository.js';
import { createAttendanceService } from '../attendance/attendance.service.js';
import { createConcernsRepository, createConcernsService } from '../concerns/index.js';
import { createDailyKpiRepository } from '../daily-kpi/dailyKpi.repository.js';
import { createDailyKpiService } from '../daily-kpi/dailyKpi.service.js';
import { createEmployeesRepository, createEmployeesService } from '../employees/index.js';
import { createHiringRepository } from '../hiring/hiring.repository.js';
import { createHiringService } from '../hiring/hiring.service.js';
import { createLeavesRepository } from '../leaves/leaves.repository.js';
import { createLeavesService } from '../leaves/leaves.service.js';
import {
  createOnboardingRepository,
  createOnboardingService,
} from '../onboarding/index.js';
import { createPerformanceRepository } from '../performance/performance.repository.js';
import { createPerformanceService } from '../performance/performance.service.js';
import { createPoliciesRepository } from '../policies/policies.repository.js';
import { createPoliciesService } from '../policies/policies.service.js';
import { createRecognitionsRepository } from '../recognitions/recognitions.repository.js';
import { createRecognitionsService } from '../recognitions/recognitions.service.js';
import { createSettingsRepository } from '../settings/index.js';
import { createAssistantRepository } from './assistant.repository.js';
import type { ChatInput, QuickInput } from './assistant.schema.js';
import {
  assistantClient,
  createAssistantService,
  type AssistantEvent,
} from './assistant.service.js';

/** Composition root: the tools read through the same services the pages use. */
const service = (req: Request) => {
  const authz = createAuthzRepository(req.db);
  const settings = createSettingsRepository(req.db);
  const attendance = createAttendanceService({
    repo: createAttendanceRepository(req.db),
    authz,
    settings,
  });
  const performance = createPerformanceService({
    repo: createPerformanceRepository(req.db),
    authz,
    settings,
  });
  const onboarding = createOnboardingService({
    repo: createOnboardingRepository(req.db),
    authz,
  });
  const repo = createAssistantRepository(req.db);
  return createAssistantService({
    repo,
    authz,
    settings,
    client: assistantClient,
    services: {
      attendance,
      performance,
      onboarding,
      leaves: createLeavesService({
        repo: createLeavesRepository(req.db),
        authz,
        settings,
      }),
      dailyKpi: createDailyKpiService({
        repo: createDailyKpiRepository(req.db),
        attendance,
        performance,
        settings,
      }),
      employees: createEmployeesService({
        repo: createEmployeesRepository(req.db),
        settings,
        authz,
        onboarding,
      }),
      concerns: createConcernsService({
        repo: createConcernsRepository(req.db),
        authz,
        settings,
      }),
      policies: createPoliciesService({ repo: createPoliciesRepository(req.db) }),
      recognitions: createRecognitionsService({
        repo: createRecognitionsRepository(req.db),
        authz,
        settings,
      }),
      hiring: createHiringService({ repo: createHiringRepository(req.db), settings }),
      actionablePeople: repo.actionablePeople,
    },
  });
};

/** HTTP layer only: gate as JSON, then stream the answer as server-sent events. */
export const assistantController = {
  chat: async (req: Request, res: Response): Promise<void> => {
    const input: ChatInput = req.body;
    const assistant = service(req);
    // Refusals (switched off, not HR/manager, daily cap) answer as JSON errors.
    const caller = await assistant.gate(req.auth!.userId, req.auth!.employeeId);

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const emit = (e: AssistantEvent) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`);
    };

    await assistant.chat(caller, input.messages, emit, abort.signal);
    req.log.info({ employeeId: caller.employeeId }, 'assistant message answered');
    res.end();
  },

  /** The offline buttons: one read, no model; same gating minus the key. */
  quick: async (req: Request, res: Response): Promise<void> => {
    const input: QuickInput = req.body;
    const result = await service(req).quick(
      req.auth!.userId,
      req.auth!.employeeId,
      input.question,
    );
    req.log.info(
      { question: input.question, tool: result.tool },
      'assistant quick answer',
    );
    res.status(200).json(result);
  },
};
