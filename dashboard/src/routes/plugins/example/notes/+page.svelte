<script lang="ts">
	import { base } from '$app/paths';
	import { when } from '$lib/format';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	const here = `${base}/plugins/example/notes`;
</script>

<svelte:head><title>Notes · Open Brain</title></svelte:head>

<section class="space-y-6">
	<header>
		<h1 class="text-xl font-semibold">Notes</h1>
		<p class="text-sm text-text-muted mt-1 [overflow-wrap:anywhere]" data-testid="plugin">From the plugin “{data.plugin.title}”: {data.plugin.description}</p>
	</header>

	<form method="GET" action={here} class="bg-bg-card border border-white/10 rounded-xl p-5 flex flex-wrap gap-3 text-sm items-end" data-testid="choose">
		<label class="flex flex-col gap-1 grow min-w-0">A thought’s id
			<input name="thought" value={data.thought ?? data.typed} maxlength="80" spellcheck="false" autocomplete="off" class="field font-mono" />
		</label>
		<div><button type="submit" class="button">Show its notes</button></div>
	</form>

	{#if data.typed}
		<p class="text-sm text-amber-300" role="alert" data-testid="bad-id">That is not a thought id: 36 characters of hex and hyphens, as a thought’s page shows it.</p>
	{/if}

	{#if data.thought}
		<div class="bg-bg-card border border-white/10 rounded-xl p-5 space-y-4" id="notes">
			<h2 class="text-sm text-text-muted [overflow-wrap:anywhere]">
				<!-- No preload: a thought's page is a logged `fetch`, as on every list. -->
				Notes on <a class="font-mono hover:text-primary-light" href="{base}/thoughts/{data.thought}" data-sveltekit-preload-data="off" data-sveltekit-reload>{data.thought}</a>
			</h2>
			{#if !data.canList}
				<p class="text-sm text-text-muted">This key cannot read the plugin’s notes.</p>
			{:else if data.notes?.length === 0}
				<p class="text-sm text-text-muted" data-testid="no-notes">No notes on this thought.</p>
			{:else if data.notes}
				<ol class="space-y-3" data-testid="notes">
					{#each data.notes as n (n.id)}
						<li class="border-t border-white/5 pt-3 text-sm space-y-1 min-w-0">
							<div class="whitespace-pre-wrap [overflow-wrap:anywhere]">{n.note}</div>
							<div class="text-xs text-text-muted [overflow-wrap:anywhere]">{n.by} · {when(n.at)}</div>
						</li>
					{/each}
				</ol>
			{/if}
			{#if data.canPin}
				<form method="POST" action="{here}?thought={data.thought}&/pin" class="space-y-2 text-sm" data-testid="pin">
					<input type="hidden" name="thought_id" value={data.thought} />
					<label class="flex flex-col gap-1">Pin a note
						<textarea name="note" rows="3" maxlength="2000" required class="field" value={form?.note ?? ''}></textarea>
					</label>
					{#if form?.error}<p class="text-amber-300" role="alert" data-testid="pin-error">{form.error}</p>{/if}
					<button type="submit" class="button">Pin it</button>
				</form>
			{/if}
		</div>
	{/if}

	{#if data.recent}
		<div class="bg-bg-card border border-white/10 rounded-xl p-5 space-y-3">
			<h2 class="text-sm text-text-muted">The newest thoughts</h2>
			{#if data.recent.length === 0}
				<p class="text-sm text-text-muted">The brain holds no thought yet.</p>
			{:else}
				<ul class="space-y-1 text-sm" data-testid="recent">
					{#each data.recent as t (t.id)}
						<li class="flex flex-wrap gap-x-3 min-w-0">
							<a class="font-mono hover:text-primary-light [overflow-wrap:anywhere]" href="{here}?thought={t.id}" aria-current={t.id === data.thought ? 'true' : undefined}>{t.id}</a>
							<span class="text-text-muted">{t.type ?? 'no type'} · {t.at ? when(t.at) : 'undated'}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</section>
