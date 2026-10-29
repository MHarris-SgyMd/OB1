import type { PageServerLoad } from './$types';
import { firstLine, oneLine } from '$lib/format';
import { wholeIn, wordIn, wordOf } from '$lib/params';
import { read } from '$lib/server/rest';
import type { ProposalsResult } from '$lib/types';
import { SAID_BY, TRUST } from '../../../../server-portable/core/filter.ts';

const STATUSES = ['pending', 'accepted', 'rejected', 'stale', 'all'] as const;
/** Lineage, as the core's three-way `lineage`: every pair, only lineage pairs, or none of them. */
const LINEAGE = ['any', 'only', 'none'] as const;

/** The verdict in the tool's words (render.ts's renderSupersessionProposals). */
const VERDICT = {
	newer_supersedes_older: 'the newer thought supersedes the older',
	older_supersedes_newer: 'the older thought supersedes the newer',
	conflict_undirected: 'one is out of date, which not stated',
} as const;

// Supersession proposals (SMD-2280 PR 2b): the pairs the consolidation pass
// judged one to outdate or duplicate the other, most confident first, with its
// verdict, its reason and both thoughts as they are now. Read only: nothing is
// written to a thought until a reviewer accepts a proposal, which is the CLI's
// (db/consolidate.ts --accept/--reject, its writer and lineage guards with it);
// SMD-3322 brings it here once SMD-3338 gives it a REST-core operation. The
// page reads the most confident `limit`; the core's cursor (`after`, SMD-3249) is not followed here yet.
export const load: PageServerLoad = async (event) => {
	const params = event.url.searchParams;
	const q = { status: wordIn(params, 'status', STATUSES, 'pending'), lineage: wordIn(params, 'lineage', LINEAGE, 'any'), limit: wholeIn(params, 'limit', 1, 200, 25) };
	const v = (await read(event, event.locals.session!, 'list_supersession_proposals', {
		status: q.status,
		limit: q.limit,
		...(q.lineage === 'any' ? {} : { lineage: q.lineage === 'only' }),
	})) as ProposalsResult;
	// Each side as the page shows it: its first line, its writer's marks (any write key writes them), what supersedes it.
	const side = (s: ProposalsResult['proposals'][number]['newer']) => ({
		id: s.id,
		line: firstLine(s.content),
		created_at: s.created_at,
		edited: s.edited,
		writer: s.writer && { name: s.writer.name === null ? null : oneLine(s.writer.name, 80), kind: wordOf(SAID_BY, s.writer.kind), trust: wordOf(TRUST, s.writer.trust), captureOnly: s.writer.captureOnly },
		supersededBy: s.supersededBy,
	});
	return {
		q,
		proposals: v.proposals.map((p) => ({
			id: p.id,
			status: p.status,
			verdict: VERDICT[p.verdict] ?? p.verdict,
			confidence: p.confidence,
			// The judge reads both thoughts' text, which can steer it: its reason and the review note are one line each.
			reason: p.reason === null ? null : oneLine(p.reason, 300),
			judgeKey: oneLine(p.judgeKey, 120),
			judgedAt: p.judgedAt,
			reviewedAt: p.reviewedAt,
			reviewNote: p.reviewNote === null ? null : oneLine(p.reviewNote, 300),
			// While accepted: the side whose supersedes column the acceptance wrote.
			stands: p.status === 'accepted' && p.supersedingId ? (p.supersedingId === p.newer.id ? 'newer' : p.supersedingId === p.older.id ? 'older' : null) : null,
			lineage: p.lineage,
			newer: side(p.newer),
			older: side(p.older),
		})),
	};
};
