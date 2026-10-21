import { eq } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import { departments } from '../../db/schema/index.js';
import type { CreateDepartmentInput } from './departments.schema.js';

export type DepartmentRow = typeof departments.$inferSelect;

/** DB access for the department tree. */
export const createDepartmentsRepository = (db: DbClient) => ({
  list: async (): Promise<DepartmentRow[]> =>
    db.orm.select().from(departments).orderBy(departments.name),

  findById: async (id: string): Promise<DepartmentRow | undefined> => {
    const rows = await db.orm
      .select()
      .from(departments)
      .where(eq(departments.id, id))
      .limit(1);
    return rows[0];
  },

  insert: async (input: CreateDepartmentInput): Promise<DepartmentRow> => {
    const rows = await db.orm.insert(departments).values(input).returning();
    return rows[0]!;
  },
});

export type DepartmentsRepository = ReturnType<typeof createDepartmentsRepository>;
