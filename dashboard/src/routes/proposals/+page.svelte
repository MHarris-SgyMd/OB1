<script lang="ts">
	import { base } from '$app/paths';
	import { when } from '$lib/format';
	import { tidy } from '$lib/tidy';
	import { ingestedNotice } from '../../../../server-portable/core/filter.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const apply = (e: Event) => (e.currentTarget as HTMLSelectElement).form?.requestSubmit();
	const tidyForm = tidy({ status: 'pending', lineage: 'any', limit: '25' });
	type Side = PageData['proposals'][number]['newer'];
	/** Who wrote a side, in the read tools' By: line's words (render.ts's actorLine and proposalWriterLine). */
	const by = (s: Side) => {
		if (!s.writer) return null;
		const w = s.writer;
		const line = !w.name && !w.kind && !w.trust ? 'not recorded' : `${w.name || 'an unnamed key'} (${w.kind ?? 'kind not classified'}) · trust ${w.trust ?? 'not recorded'}`;
		return w.captureOnly ? `${line} · a capture-only key’s text` : line;
	};
</script>

<svelte:head><title>Proposals · Open Brain</title></svelte:head>

<section class="space-y-6">
	<h1 class="text-xl font-semibold">Supersession proposals</h1>

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
			The consolidation pass proposes; nothing is written to a thought until a reviewer accepts a proposal (<code>cd db &amp;&amp; bun consolidate.ts --url $DATABASE_URL --accept</code> or <code>--reject</code>, or the review_supersession_proposal tool). Most confident first. Before an accept, read the pair in <code>--list</code> or the list_supersession_proposals tool: they name the writer flags and the pointers an accept would clear, which this page does not.
		</p>
		{#if data.proposals.length === 0}
			<p class="text-sm text-text-muted" data-testid="empty">No {data.q.status === 'all' ? '' : `${data.q.status} `}proposal{data.q.lineage === 'only' ? ' on a lineage pair' : data.q.lineage === 'none' ? ' off a lineage pair' : ''}.</p>
		{:else}
			<!-- As the other lists': no preload (a thought's page is a logged `fetch`), and a full load. -->
			<ol class="space-y-4" data-testid="proposals" data-sveltekit-preload-data="off" data-sveltekit-reload>
				{#each data.proposals as p (p.id)}
					<li class="border-t border-white/5 pt-3 text-sm space-y-2 min-w-0">
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
					</li>
				{/each}
			</ol>
		{/if}
	</div>
</section>
