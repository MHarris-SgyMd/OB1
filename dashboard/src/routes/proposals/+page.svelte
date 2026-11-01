<script lang="ts">
	import { base } from '$app/paths';
	import { when } from '$lib/format';
	import { tidy } from '$lib/tidy';
	import { ingestedNotice } from '../../../../server-portable/core/filter.ts';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	const apply = (e: Event) => (e.currentTarget as HTMLSelectElement).form?.requestSubmit();
	const tidyForm = tidy({ status: 'pending', lineage: 'any', limit: '25' });
	type Proposal = PageData['proposals'][number];
	type Side = Proposal['newer'];
	/** Who wrote a side, in the read tools' By: line's words (render.ts's actorLine and proposalWriterLine). */
	const by = (s: Side) => {
		if (!s.writer) return null;
		const w = s.writer;
		const line = !w.name && !w.kind && !w.trust ? 'not recorded' : `${w.name || 'an unnamed key'} (${w.kind ?? 'kind not classified'}) · trust ${w.trust ?? 'not recorded'}`;
		return w.captureOnly ? `${line} · a capture-only key’s text` : line;
	};
	/** Who decided a row (SMD-3338), in the listing's words (render.ts's reviewerText): the kind then, else now, said so. */
	const decidedBy = (r: Proposal['reviewer']) => {
		if (!r) return 'not recorded';
		const kind = r.kind ?? (r.kindNow ? `${r.kindNow} — classified after it decided` : 'kind not classified');
		if (r.name && r.agentRecorded) return `${r.name} (${kind})`;
		if (r.name) return `${r.name}, no agent id recorded`;
		return `an agent with no name (${kind})`;
	};
	const decided = (p: Proposal) => p.status === 'accepted' || p.status === 'rejected';
	/** A decision's action with the page's filters, so the page after it — a refusal's, or the redirect's — lists the same rows. */
	const actionOf = (name: 'accept' | 'reject') => {
		const q = new URLSearchParams();
		if (data.q.status !== 'pending') q.set('status', data.q.status);
		if (data.q.lineage !== 'any') q.set('lineage', data.q.lineage);
		if (data.q.limit !== 25) q.set('limit', String(data.q.limit));
		const s = q.toString();
		return `?/${name}${s ? `&${s}` : ''}`;
	};
	/** A refusal of a decision on this row: said beside it, with "Accept anyway" where force waives it. */
	const refusalOf = (p: Proposal) => (form?.id === p.id ? form : null);
</script>

<svelte:head><title>Proposals · Open Brain</title></svelte:head>

<section class="space-y-6">
	<h1 class="text-xl font-semibold">Supersession proposals</h1>

	{#if form?.error && !form.id}
		<p class="text-sm text-amber-300" role="alert" data-testid="review-error">{form.error}</p>
	{:else if data.done}
		<p class="text-sm" role="status" data-testid="review-done">{data.done}</p>
	{/if}

	<form method="GET" action="{base}/proposals" onformdata={tidyForm} class="bg-bg-card border border-white/10 rounded-xl p-5 grid gap-3 sm:grid-cols-4 text-sm items-end" data-testid="filters" data-sveltekit-keepfocus data-sveltekit-noscroll>
		<label class="flex flex-col gap-1">Status
			<select name="status" onchange={apply} class="field">
				{#each ['pending', 'accepted', 'rejected', 'stale', 'all'] as s (s)}<option value={s} selected={data.q.status === s}>{s}</option>{/each}
			</select>
		</label>
		<label class="flex flex-col gap-1">Lineage pairs
			<select name="lineage" onchange={apply} class="field">
				<option value="any" selected={data.q.lineage === 'any'}>with the rest</option>
				<option value="only" selected={data.q.lineage === 'only'}>only</option>
				<option value="none" selected={data.q.lineage === 'none'}>left out</option>
			</select>
		</label>
		<label class="flex flex-col gap-1">How many<input name="limit" type="number" min="1" max="200" step="1" value={data.q.limit} class="field" /></label>
		<div><button type="submit" class="button">Apply</button></div>
	</form>

	<div class="bg-bg-card border border-white/10 rounded-xl p-5 space-y-4">
		<p class="text-sm text-text-muted">
			The consolidation pass proposes; nothing is written to a thought until a reviewer accepts a proposal{data.canReview ? ' — here, or' : ''} through <code>cd db &amp;&amp; bun consolidate.ts --url $DATABASE_URL --accept</code> or <code>--reject</code>, or the review_supersession_proposal tool. An accept writes the side that stands as superseding the other; a reject records the decision and undoes an accept’s pointer. Most confident first. Before an accept, read the pair in <code>--list</code> or the list_supersession_proposals tool: they name the writer flags and the pointers an accept would clear, which this page does not; an accept the brain’s checks refuse is said here, with the way to accept it anyway.
		</p>
		{#if !data.reviewersRead && data.proposals.some(decided)}
			<p class="text-sm text-text-muted" data-testid="reviewers-unread">Who decided each row is not shown: this brain is short of migration 114.</p>
		{/if}
		{#if data.proposals.length === 0}
			<p class="text-sm text-text-muted" data-testid="empty">No {data.q.status === 'all' ? '' : `${data.q.status} `}proposal{data.q.lineage === 'only' ? ' on a lineage pair' : data.q.lineage === 'none' ? ' off a lineage pair' : ''}.</p>
		{:else}
			<!-- As the other lists': no preload (a thought's page is a logged `fetch`), and a full load. -->
			<ol class="space-y-4" data-testid="proposals" data-sveltekit-preload-data="off" data-sveltekit-reload>
				{#each data.proposals as p (p.id)}
					{@const refused = refusalOf(p)}
					<li class="border-t border-white/5 pt-3 text-sm space-y-2 min-w-0" id="proposal-{p.id}">
						<div class="[overflow-wrap:anywhere]">
							<span class="font-semibold">{p.confidence.toFixed(2)}</span> — {p.verdict}{#if p.lineage}<span class="ml-2 text-amber-300">lineage pair: one side derives from the other</span>{/if}
						</div>
						{#if p.reason}<div class="text-text-muted [overflow-wrap:anywhere]">Reason: {p.reason}</div>{/if}
						{#each [['newer', p.newer], ['older', p.older]] as const as [label, s] (label)}
							{@const notice = s.writer ? ingestedNotice({ trust: s.writer.trust }) : null}
							<div class="pl-3 border-l border-white/10 space-y-0.5 [overflow-wrap:anywhere]">
								<div class="text-text-muted">{label}{p.stands === label ? ' — stands' : ''} · {s.created_at ? when(s.created_at) : 'undated'}{s.edited ? ' · edited since judged' : ''}</div>
								{#if notice}<div class="text-amber-300" role="note">{notice}</div>{/if}
								<a class="hover:text-primary-light" href="{base}/thoughts/{s.id}">{s.line}</a>
								{#if by(s)}<div class="text-xs text-text-muted">By: {by(s)}</div>{/if}
								{#if s.supersededBy}<div class="text-xs text-text-muted font-mono">superseded by {s.supersededBy}</div>{/if}
							</div>
						{/each}
						<div class="text-xs text-text-muted [overflow-wrap:anywhere]">
							Proposal <span class="font-mono">{p.id}</span> — judged by {p.judgeKey} {when(p.judgedAt)} · {p.status}{p.reviewedAt ? ` ${when(p.reviewedAt)}` : ''}{p.reviewNote ? `: ${p.reviewNote}` : ''}
						</div>
						{#if data.reviewersRead && decided(p)}<div class="text-xs text-text-muted [overflow-wrap:anywhere]" data-testid="decided-by">Decided by {decidedBy(p.reviewer)}</div>{/if}
						{#if data.canReview}
							<!-- One form, a button per decision (SMD-3322 PR 4): the clicked button's formaction, the page's filters in it,
							     and, on an undirected verdict, its side. -->
							<form method="POST" class="flex flex-wrap gap-2 items-end" data-testid="review" aria-label="Decide proposal {p.id}">
								<input type="hidden" name="id" value={p.id} />
								{#if p.status !== 'accepted'}
									{#if p.undirected}
										<button type="submit" formaction={actionOf('accept')} name="direction" value="newer" class="button text-xs">Accept: newer stands</button>
										<button type="submit" formaction={actionOf('accept')} name="direction" value="older" class="button text-xs">Accept: older stands</button>
									{:else}
										<button type="submit" formaction={actionOf('accept')} class="button text-xs">Accept</button>
									{/if}
								{/if}
								<button type="submit" formaction={actionOf('reject')} class="button text-xs">{p.status === 'accepted' ? 'Reject (undo the accept)' : p.status === 'rejected' ? 'Reject again' : 'Reject'}</button>
								<label class="flex flex-col gap-1 text-xs grow">Note (optional)
									<input name="note" maxlength="2000" class="field" value={refused?.note ?? ''} />
								</label>
							</form>
						{/if}
						{#if refused}
							<p class="text-sm text-amber-300 [overflow-wrap:anywhere]" role="alert" data-testid="review-error">{refused.error}</p>
							{#if refused.forceable}
								<form method="POST" action={actionOf('accept')} data-testid="force">
									<input type="hidden" name="id" value={p.id} />
									{#if refused.direction}<input type="hidden" name="direction" value={refused.direction} />{/if}
									<input type="hidden" name="note" value={refused.note ?? ''} />
									<input type="hidden" name="force" value="1" />
									<button type="submit" class="button text-xs">Accept anyway</button>
								</form>
							{/if}
						{/if}
					</li>
				{/each}
			</ol>
		{/if}
	</div>
</section>
