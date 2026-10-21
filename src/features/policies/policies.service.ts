import createError from 'http-errors';
import type {
  ActorContext,
  PoliciesRepository,
  PolicyAckRow,
  PolicyRow,
} from './policies.repository.js';
import type {
  AckResultDto,
  AckState,
  CreatePolicyInput,
  MyPolicyDto,
  PolicyDto,
  PolicyTrackerDto,
  UpdatePolicyInput,
} from './policies.schema.js';

const toPolicy = (row: PolicyRow, docIds: Set<string>): PolicyDto => ({
  id: row.id,
  code: row.code,
  title: row.title,
  category: row.category,
  version: row.version,
  ackRequired: row.ackRequired,
  summary: row.summary,
  docUrl: row.docUrl,
  hasDocument: docIds.has(row.id),
  effectiveFrom: row.effectiveFrom,
  retiredAt: row.retiredAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
};

/** The latest signature per policy — acks are append-only, newest first. */
const latestByPolicy = (acks: PolicyAckRow[]): Map<string, PolicyAckRow> => {
  const map = new Map<string, PolicyAckRow>();
  for (const a of acks) if (!map.has(a.policyId)) map.set(a.policyId, a);
  return map;
};

const stateOf = (policy: PolicyRow, ack: PolicyAckRow | undefined): AckState =>
  !ack ? 'none' : ack.version === policy.version ? 'ok' : 'stale';

/**
 * Policy rules (adopted from the hr-tool review, user decision):
 *  - an acknowledgement binds a PERSON to a VERSION, append-only;
 *  - bumping `version` is the one act that re-asks everyone — old signatures
 *    stay on record and read as `stale`;
 *  - the library is readable by every signed-in employee; managing it and the
 *    tracker need an `hrbp.policies` grant (route middleware);
 *  - a RETIRED policy leaves the library, My policies and the tracker and
 *    can't be signed; its row and signatures are kept, and HR can restore it.
 */
export const createPoliciesService = (deps: { repo: PoliciesRepository }) => {
  const { repo } = deps;

  const requireRow = async (id: string): Promise<PolicyRow> => {
    const row = await repo.findById(id);
    if (!row) throw createError(404, 'Policy not found', { code: 'POLICY_NOT_FOUND' });
    return row;
  };

  const list = async (): Promise<PolicyDto[]> => {
    const [rows, docIds] = await Promise.all([repo.list(), repo.documentPolicyIds()]);
    return rows.map((p) => toPolicy(p, docIds));
  };

  /** HR's management list: live AND retired, so a retired one can be restored. */
  const listForManagement = async (): Promise<PolicyDto[]> => {
    const [rows, docIds] = await Promise.all([
      repo.list({ includeRetired: true }),
      repo.documentPolicyIds(),
    ]);
    return rows.map((p) => toPolicy(p, docIds));
  };

  const retire = async (id: string, actor: ActorContext): Promise<PolicyDto> => {
    const policy = await requireRow(id);
    if (policy.retiredAt) {
      throw createError(409, 'This policy is already retired', {
        code: 'POLICY_RETIRED',
      });
    }
    return toPolicy(
      await repo.setRetired(policy, actor.actorEmployeeId, actor),
      await repo.documentPolicyIds(),
    );
  };

  const restore = async (id: string, actor: ActorContext): Promise<PolicyDto> => {
    const policy = await requireRow(id);
    if (!policy.retiredAt) {
      throw createError(409, 'This policy is not retired', {
        code: 'POLICY_NOT_RETIRED',
      });
    }
    return toPolicy(
      await repo.setRetired(policy, null, actor),
      await repo.documentPolicyIds(),
    );
  };

  /** The caller's library view: every policy + their own ack state. */
  const mine = async (employeeId: string): Promise<MyPolicyDto[]> => {
    const [rows, acks, docIds] = await Promise.all([
      repo.list(),
      repo.listAcksFor(employeeId),
      repo.documentPolicyIds(),
    ]);
    const latest = latestByPolicy(acks);
    return rows.map((p) => {
      const ack = latest.get(p.id);
      return {
        ...toPolicy(p, docIds),
        ack: {
          state: stateOf(p, ack),
          ackedVersion: ack?.version ?? null,
          ackedAt: ack?.ackedAt.toISOString() ?? null,
        },
      };
    });
  };

  const acknowledge = async (
    policyId: string,
    actor: ActorContext,
  ): Promise<AckResultDto> => {
    const policy = await requireRow(policyId);
    if (policy.retiredAt) {
      throw createError(409, 'This policy has been retired and no longer needs signing', {
        code: 'POLICY_RETIRED',
      });
    }
    try {
      const row = await repo.insertAck(policy, actor.actorEmployeeId, actor);
      return {
        policyId: policy.id,
        version: row.version,
        ackedAt: row.ackedAt.toISOString(),
      };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw createError(409, 'You have already acknowledged this version', {
          code: 'ALREADY_ACKNOWLEDGED',
        });
      }
      throw err;
    }
  };

  const create = async (
    input: CreatePolicyInput,
    actor: ActorContext,
  ): Promise<PolicyDto> => {
    try {
      return toPolicy(await repo.insert(input, actor), new Set());
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw createError(409, 'A policy with this code already exists', {
          code: 'DUPLICATE_POLICY',
        });
      }
      throw err;
    }
  };

  const update = async (
    id: string,
    input: UpdatePolicyInput,
    actor: ActorContext,
  ): Promise<PolicyDto> => {
    const current = await requireRow(id);
    const bumped = input.version !== undefined && input.version !== current.version;
    // Everyone who signed an earlier version is now stale — the bell asks them
    // to re-acknowledge (refinement plan, Policies). Only for ack-required
    // policies; people who never signed already show as pending.
    const ackRequired = input.ackRequired ?? current.ackRequired;
    // A retired policy asks nobody to sign.
    const signers =
      bumped && ackRequired && !current.retiredAt ? await repo.listSignerIds(id) : [];
    const title = input.title ?? current.title;
    const row = await repo.update(
      id,
      input,
      actor,
      {
        // A version bump is the audited "everyone signs again" act; any other
        // edit is an in-place correction that touches no acknowledgement.
        action: bumped ? 'policy.version_bumped' : 'policy.updated',
        detail: bumped
          ? { code: current.code, from: current.version, to: input.version }
          : { code: current.code, fields: Object.keys(input) },
      },
      signers.length > 0
        ? {
            recipientIds: signers,
            event: {
              type: 'policy.reack',
              title: `Re-acknowledge ${title}`,
              body: `${title} is now version ${input.version} — your acknowledgement is outdated.`,
              link: '/policies',
            },
          }
        : undefined,
    );
    if (!row) throw createError(404, 'Policy not found', { code: 'POLICY_NOT_FOUND' });
    return toPolicy(row, await repo.documentPolicyIds());
  };

  /** HR grid: live people × ack-required policies. */
  const tracker = async (): Promise<PolicyTrackerDto> => {
    const [rows, people, acks, docIds] = await Promise.all([
      repo.list(),
      repo.listTrackedEmployees(),
      repo.listAllAcks(),
      repo.documentPolicyIds(),
    ]);
    const required = rows.filter((p) => p.ackRequired);
    // latest ack per (employee, policy) — acks come newest first.
    const latest = new Map<string, PolicyAckRow>();
    for (const a of acks) {
      const key = `${a.employeeId}:${a.policyId}`;
      if (!latest.has(key)) latest.set(key, a);
    }
    return {
      policies: required.map((p) => toPolicy(p, docIds)),
      rows: people.map((person) => ({
        employee: person,
        cells: required.map((p) => {
          const ack = latest.get(`${person.id}:${p.id}`);
          return {
            policyId: p.id,
            state: stateOf(p, ack),
            ackedVersion: ack?.version ?? null,
            ackedAt: ack?.ackedAt.toISOString() ?? null,
          };
        }),
      })),
    };
  };

  /** The stored PDF itself — any signed-in employee may read it. */
  const document = async (policyId: string) => {
    await requireRow(policyId);
    const doc = await repo.findDocument(policyId);
    if (!doc) {
      throw createError(404, 'No document is stored for this policy', {
        code: 'DOCUMENT_NOT_FOUND',
      });
    }
    return doc;
  };

  /** Store/replace the PDF; the external link is cleared in the same act. */
  const uploadDocument = async (
    policyId: string,
    doc: { fileName: string; contentType: string; data: Buffer },
    actor: ActorContext,
  ): Promise<PolicyDto> => {
    const policy = await requireRow(policyId);
    if (doc.data.length === 0) {
      throw createError(422, 'The uploaded file is empty', { code: 'EMPTY_DOCUMENT' });
    }
    await repo.upsertDocument(policy, doc, actor);
    const updated = await requireRow(policyId);
    return toPolicy(updated, await repo.documentPolicyIds());
  };

  return {
    list,
    listForManagement,
    mine,
    acknowledge,
    create,
    update,
    retire,
    restore,
    tracker,
    document,
    uploadDocument,
  };
};

export type PoliciesService = ReturnType<typeof createPoliciesService>;
