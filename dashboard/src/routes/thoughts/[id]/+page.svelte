<script lang="ts">
	import { base } from '$app/paths';
	import { when } from '$lib/format';
	import { ingestedNotice } from '../../../../../server-portable/core/filter.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	/** The metadata the page writes as rows; the two times are the header's. */
	const fields = $derived(
		Object.entries(data.thought.metadata)
			.filter(([k]) => k !== 'created_at' && k !== 'updated_at')
			.sort(([a], [b]) => a.localeCompare(b)),
	);
	const shown = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
	const time = (v: unknown) => (typeof v === 'string' ? when(v) : '—');
	// An ingested row says so beside its text, as the tools say it (SMD-1724).
	const notice = $derived(ingestedNotice(data.thought.metadata));
</script>

<svelte:head><title>{data.thought.title} · Open Brain</title></svelte:head>

<article class="space-y-6">
	<header>
		<h1 class="text-xl font-semibold" data-testid="title">{data.thought.title}</h1>
		<div class="text-sm text-text-muted mt-1">
			Created {time(data.thought.metadata.created_at)} · updated {time(data.thought.metadata.updated_at)}
			· <span class="font-mono">{data.thought.id}</span>
		</div>
		{#if data.canEdit || data.canDelete}
			<div class="flex gap-4 text-sm mt-2">
				{#if data.canEdit}<a class="text-primary-light hover:underline" href="{base}/thoughts/{data.thought.id}/edit" data-testid="edit-link">Edit</a>{/if}
				{#if data.canDelete}<a class="text-primary-light hover:underline" href="{base}/thoughts/{data.thought.id}/delete" data-testid="delete-link">Delete</a>{/if}
			</div>
		{/if}
	</header>

	{#if data.captured}
		<p class="text-sm" role="status" data-testid="captured">
			{#if data.captured.existed}
				That text was already a thought, so the capture merged into it: its source is now dashboard, and the metadata extracted this time was merged into its own (the audit trail records any change).{#if data.captured.noVector}{' '}This capture wrote no embedding; the thought keeps the one it had, if any.{/if}
			{:else}
				Captured.{#if data.captured.noVector}{' '}It was saved without an embedding, so a search by meaning will not find it until it is re-embedded; a search by exact text will.{/if}
			{/if}
		</p>
	{/if}
	{#if notice}
		<p class="text-sm text-amber-300" role="note" data-testid="notice">{notice}</p>
	{/if}
	<div class="bg-bg-card border border-white/10 rounded-xl p-5 whitespace-pre-wrap break-words" data-testid="text">{data.thought.text}</div>

	<div class="bg-bg-card border border-white/10 rounded-xl p-5">
		<h2 class="text-sm text-text-muted mb-3">Metadata</h2>
		{#if fields.length === 0}
			<p class="text-sm text-text-muted">None.</p>
		{:else}
			<dl class="grid grid-cols-1 sm:grid-cols-[minmax(8rem,auto)_1fr] gap-x-6 gap-y-1 sm:gap-y-2 text-sm">
				{#each fields as [k, v] (k)}
					<dt class="text-text-muted">{k}</dt>
					<dd class="min-w-0 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">{shown(v)}</dd>
				{/each}
			</dl>
		{/if}
	</div>
</article>
