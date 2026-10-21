import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from '../../shared/zod.js';
import { opsPath } from './assets.docs.js';
import {
  createGatePassSchema,
  declineGatePassSchema,
  gatePassSchema,
} from './gate-passes.schema.js';

/** OpenAPI registration for the gate-pass endpoints. */
export const registerGatePassesDocs = (registry: OpenAPIRegistry): void => {
  opsPath(
    registry,
    'get',
    '/api/v1/gate-passes',
    'All gate passes (OPS)',
    z.array(gatePassSchema),
  );
  opsPath(
    registry,
    'post',
    '/api/v1/gate-passes',
    'Request a gate pass (flagged categories only; disclaimer required)',
    gatePassSchema,
    createGatePassSchema,
  );
  opsPath(
    registry,
    'post',
    '/api/v1/gate-passes/{id}/approve',
    'Approve — the item may leave',
    gatePassSchema,
  );
  opsPath(
    registry,
    'post',
    '/api/v1/gate-passes/{id}/decline',
    'Decline with a reason',
    gatePassSchema,
    declineGatePassSchema,
  );
  opsPath(
    registry,
    'post',
    '/api/v1/gate-passes/{id}/back',
    'OPS marks it back at its zone',
    gatePassSchema,
  );
};
