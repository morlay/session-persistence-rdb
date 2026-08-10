/**
 * 会话 log 的表示转换：把持久化行（`t_sessions` / joined `t_session_events` +
 * `t_events` 行）转换为上游 `SessionHeader` / `SessionEvent`，以及反向的
 * 分类/映射辅助。全部为方言无关的纯函数，无 I/O——测试直接单测（见
 * `tests/rdb.spec.ts`）。
 *
 * delta 过滤（`assistant/chunk` 不落库）后，持久化 seq 是稠密重编号的；
 * `buildSeqMap` 提供 上游 seq → 持久化 seq 的映射，`rowToEvent` /
 * `remapSurfaceOp` 经它把 `sourceEventSeqs` 与 `replace` 范围重映射回稠密
 * seq 空间。`scanRows` 实现崩溃尾部语义（torn tail 切割 + 提交区损坏拒绝）。
 *
 * @module @morlay/session-persistence-rdb/log
 */

import type { SessionEvent, SessionHeader, SessionId, SurfaceOp } from "@deepseek-ai/dsh-session";
import type { EventRow, SessionRow } from "./backend.ts";

/**
 * Reconstruct the {@link SessionHeader} from a `t_sessions` row.
 * @param row - the `t_sessions` table row.
 * @returns the header, `NULL` columns mapped to omitted optional fields.
 */
export function rowToMeta(row: SessionRow): SessionHeader {
  if (!Number.isSafeInteger(row.fCreatedAt) || row.fCreatedAt < 0) {
    throw new Error("stored session createdAt must be a non-negative safe integer");
  }
  return {
    version: row.fVersion,
    id: row.fSessionId as SessionId,
    createdAt: row.fCreatedAt,
    ...(row.fCwd !== null ? { cwd: row.fCwd } : {}),
    ...(row.fParentSession !== null ? { parentSession: row.fParentSession as SessionId } : {}),
    ...(row.fSeedLength !== null ? { seedLength: row.fSeedLength } : {}),
    ...(row.fOrigin !== null ? { origin: row.fOrigin as "subagent" } : {}),
    ...(row.fDelegationDepth === null ? {} : { delegationDepth: row.fDelegationDepth }),
  };
}

/**
 * Remap a stored {@link SurfaceOp} from upstream seqs to persisted seqs. An
 * `append` op carries no seqs; a positional `replace`'s `start`/`end` name
 * surface nodes by UPSTREAM seq and must follow {@link SessionEvent.sourceEventSeqs}
 * through the same upstream→persisted map when delta filtering re-numbered the
 * log — otherwise the replacement range is looked up against DENSE seqs and the
 * surface fold rejects the log ("start seq N not found in surface").
 * @param op - the stored surface op.
 * @param remap - upstream→persisted seq mapping (identity when absent).
 * @returns the remapped surface op.
 */
export function remapSurfaceOp(op: SurfaceOp, remap: (seq: number) => number): SurfaceOp {
  if (op === "append") return op;
  return { op: "replace", start: remap(op.start), end: remap(op.end) };
}

/**
 * Reconstruct a {@link SessionEvent} from a joined row. The emitted event
 * carries the DENSE persisted seq (`row.fSequence`); `sourceEventSeqs` entries
 * and a positional `replace` {@link SurfaceOp}'s range are remapped from
 * upstream seqs to persisted seqs through `seqMap` when the log was
 * delta-filtered (an entry missing from the map is kept verbatim — tolerated
 * like a scan hole, not corruption).
 * @param row - the joined `t_session_events` + `t_events` row.
 * @param seqMap - upstream→persisted seq map, present only when delta filtering
 *   re-numbered the log (optional).
 * @returns the reconstructed event; throws when a JSON column fails to parse
 *   ({@link scanRows} treats that as a hole, not corruption, in the tail).
 */
export function rowToEvent(row: EventRow, seqMap?: ReadonlyMap<number, number>): SessionEvent {
  // Surface-metadata fields are conditional on the event type in the type
  // system; spread them so each variant gets only the fields it declares.
  const remap = (seq: number) => seqMap?.get(seq) ?? seq;
  const surfaceFields = {
    ...(row.fSourceEventSeqs !== null
      ? {
          sourceEventSeqs: (JSON.parse(row.fSourceEventSeqs) as number[]).map(remap),
        }
      : {}),
    ...(row.fSurfaceOp !== null
      ? {
          surfaceOp: remapSurfaceOp(JSON.parse(row.fSurfaceOp) as SurfaceOp, remap),
        }
      : {}),
  };
  return {
    type: row.fKind as SessionEvent["type"],
    seq: row.fSequence,
    time: row.fCreatedAt,
    data: JSON.parse(row.fData) as SessionEvent["data"],
    ...surfaceFields,
  } as SessionEvent;
}

/**
 * Build the upstream→persisted seq map for one session's persisted events
 * (only meaningful when delta filtering re-numbered the log).
 *
 * A session re-opened by resume (or forked) persists the seed segment and the
 * new segment in ONE log: the seed rows keep the PARENT session's upstream seqs
 * while the resumed rows carry the child session's own upstream seqs, which
 * renumber from the seed boundary and therefore OVERLAP the parent space. The
 * FIRST mapping wins so a seed-segment event's provenance reference resolves to
 * the seed-space row it actually derived from (rows are ordered by persisted
 * seq, so the seed segment always precedes the resumed one); the resumed
 * segment's references are unique within their own space unless they point at a
 * shared value, which only the parent could have produced first.
 * @param rows - one session's seq rows (upstream + persisted), ordered by seq
 *   ascending (only the two seq columns are needed).
 * @returns map from `f_original_seq` to `f_sequence` (first occurrence wins).
 */
export function buildSeqMap(
  rows: readonly Pick<EventRow, "fSequence" | "fOriginalSeq">[],
): Map<number, number> {
  const map = new Map<number, number>();
  for (const row of rows) {
    if (!map.has(row.fOriginalSeq)) map.set(row.fOriginalSeq, row.fSequence);
  }
  return map;
}

/**
 * Prune `sourceEventSeqs` references that cannot be remapped on read.
 *
 * `sourceEventSeqs` references events by UPSTREAM seq; on read the references
 * are remapped to the DENSE persisted seq through {@link buildSeqMap}. A
 * reference whose event never got a persisted row (a dropped delta, or a seq
 * that never existed) has no map entry and would replay as a `source >=
 * current seq` provenance violation, so the write path prunes it. A fully
 * pruned list is stored as null (no provenance) by the serializer.
 *
 * The `keep` predicate is the CALLER's view of resolvability: the write path
 * knows which upstream seqs THIS INSTANCE dropped (`WriteGuard.pruneRefs` —
 * per-instance knowledge, which must not prune references to rows another
 * instance persisted, e.g. a resume seed segment), while the one-shot repair
 * script knows which upstream seqs exist on DISK (full-database view). The
 * filter itself is shared so the rule lives in one place.
 * @param refs - the event's `sourceEventSeqs` (upstream seqs).
 * @param keep - true for a seq whose referenced event is resolvable.
 * @returns the pruned list.
 */
export function pruneSourceEventSeqs(
  refs: readonly number[],
  keep: (seq: number) => boolean,
): number[] {
  return refs.filter(keep);
}

/**
 * Find the preserved prefix of ordered event rows. Fully written rows in an
 * interrupted final turn remain in the prefix. The first unparsable row or seq
 * gap after the last `turn/end` marks a tolerated torn tail; the same hole in
 * the committed region rejects.
 *
 * @param rows - one session's event rows, ordered by persisted seq ascending.
 * @param base - the persisted seq the first row is expected to carry; `0` for
 *   a whole log, the requested `fromSeq` for a suffix read (`loadStoredFrom`).
 * @param seqMap - upstream→persisted seq map forwarded to {@link rowToEvent}.
 * @returns the preserved event prefix, plus `tornFrom` — the persisted seq the
 *   physical delete starts at — when a torn tail exists.
 */
export function scanRows(
  rows: readonly EventRow[],
  base = 0,
  seqMap?: ReadonlyMap<number, number>,
): { preserved: SessionEvent[]; tornFrom?: number } {
  // Pass 1: parse each row's data; a row whose data is not valid JSON is a hole.
  // (The seq/type COLUMNS are always present even when `data` is corrupt.)
  interface Parsed {
    ok: boolean;
    event?: SessionEvent;
  }
  const parsed: Parsed[] = rows.map((row) => {
    try {
      return { ok: true, event: rowToEvent(row, seqMap) };
    } catch {
      return { ok: false };
    }
  });

  // The last index that is a valid `turn/end` — holes through a closed turn
  // are always committed corruption.
  let lastTurnEnd = -1;
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (parsed[i]?.ok && rows[i]?.fKind === "turn/end") {
      lastTurnEnd = i;
      break;
    }
  }

  // Preserve the contiguous prefix, including a complete interrupted turn;
  // holes through the last committed boundary throw, while later holes stop.
  const preserved: SessionEvent[] = [];
  for (let i = 0; i < rows.length; i++) {
    const p = parsed[i];
    if (!p?.ok || p.event === undefined) {
      if (i <= lastTurnEnd)
        throw new Error(
          `corrupt session log: unparsable committed event at seq ${rows[i]?.fSequence}`,
        );
      break; // torn tail fragment after the last turn/end — stop, tolerate
    }
    if (p.event.seq !== base + i) {
      if (i <= lastTurnEnd)
        throw new Error(
          `corrupt session log: seq gap in committed region (expected ${base + i}, got ${p.event.seq})`,
        );
      break; // gap after the last turn/end — torn tail, stop
    }
    preserved.push(p.event);
  }

  // Any rows past the preserved prefix are a never-committed torn tail; their
  // first seq is the deletion point for load's physical repair.
  return preserved.length < rows.length
    ? { preserved, tornFrom: base + preserved.length }
    : { preserved };
}
