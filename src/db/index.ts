import { createDbClient, type DbClient } from './client.js';
import * as schema from './schema/index.js';

/**
 * The application's single DbClient instance. Import `db` from here; never
 * reach for `pg` or Drizzle directly outside the repository layer.
 */
export const db: DbClient = createDbClient();

export { schema };
export type { DbClient } from './client.js';
