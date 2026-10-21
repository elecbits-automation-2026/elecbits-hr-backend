import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import {
  claimOrgSchema,
  claimRecordSchema,
  loginSchema,
  sessionSchema,
} from './auth.schema.js';

/** OpenAPI registration for the auth endpoints. */
export const registerAuthDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/login',
    tags: ['Auth'],
    summary: 'Sign in with company email + password',
    request: { body: jsonBody(loginSchema) },
    responses: {
      200: jsonResponse('Session', sessionSchema),
      401: errorResponse('Invalid credentials'),
      403: errorResponse('Not a company email'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/claim',
    tags: ['Auth'],
    summary: 'Claim the employee record HRBP created (first sign-in)',
    request: { body: jsonBody(claimRecordSchema) },
    responses: {
      201: jsonResponse('Session', sessionSchema),
      404: errorResponse('No employee record for this email'),
      409: errorResponse('Already claimed'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/claim-org',
    tags: ['Auth'],
    summary: 'One-time organization claim (Owner bootstrap; closes permanently)',
    request: { body: jsonBody(claimOrgSchema) },
    responses: {
      201: jsonResponse('Session', sessionSchema),
      403: errorResponse('Email may not claim the organization'),
      410: errorResponse('Claim path already closed'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/refresh',
    tags: ['Auth'],
    summary:
      'Renew the session from the httpOnly refresh cookie — rotates the cookie; a replayed old token revokes its whole sign-in',
    responses: {
      200: jsonResponse('Session (and a rotated refresh cookie)', sessionSchema),
      401: errorResponse('Missing, expired, revoked or deactivated — sign in again'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/logout',
    tags: ['Auth'],
    summary: "Sign out — revokes the refresh cookie's sign-in and clears the cookie",
    responses: { 204: { description: 'Signed out' } },
  });
};
