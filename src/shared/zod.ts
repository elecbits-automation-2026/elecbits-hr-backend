import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

/**
 * Zod, extended once with the `.openapi()` helper used to generate the API docs.
 *
 * Import `z` from here (not directly from 'zod') in any file whose schemas are
 * registered in the OpenAPI document. The extension must be applied before those
 * schemas are created, so centralising it here guarantees the correct order
 * regardless of module import sequence.
 */
extendZodWithOpenApi(z);

export { z };
