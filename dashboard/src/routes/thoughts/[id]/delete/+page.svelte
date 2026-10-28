<script lang="ts">
	import { base } from '$app/paths';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	const cited = $derived(form && 'cited' in form ? form.cited : undefined);
</script>

<svelte:head><title>Delete · {data.thought.title} · Open Brain</title></svelte:head>

<section class="space-y-6">
	<h1 class="text-xl font-semibold">Delete a thought</h1>

	<div class="bg-bg-card border border-white/10 rounded-xl p-5 space-y-3 text-sm">
		<p class="[overflow-wrap:anywhere]">
			<a class="font-semibold hover:text-primary-light" href="{base}/thoughts/{data.thought.id}">{data.thought.title}</a>
			<span class="text-text-muted font-mono">· {data.thought.id}</span>
		</p>
		<p class="text-text-muted [overflow-wrap:anywhere]">{data.thought.line}</p>
		<p>
			Deleting removes the thought and its search chunks. The audit trail keeps its text, so it can be put back by hand.
		</p>

		{#if cited !== undefined}
			<div class="space-y-3" data-testid="cited">
				<p class="text-amber-300" role="alert">
					{cited === null ? 'Statements' : cited === 1 ? 'One statement' : `${cited} statements`} in other thoughts {cited === 1 ? 'cites' : 'cite'} this thought as {cited === 1 ? 'its' : 'their'} source, so it was not deleted.
				</p>
				<p>Deleting it anyway keeps each statement’s text and stance, and records this thought as its deleted source.</p>
				<form method="POST" action="?/delete" data-testid="delete-anyway">
					<input type="hidden" name="detach_citations" value="true" />
					<button type="submit" class="button">Delete it anyway</button>
				</form>
			</div>
		{:else}
			{#if form && 'error' in form}
				<p class="text-amber-300" role="alert" data-testid="delete-error">{form.error}</p>
			{/if}
			<form method="POST" action="?/delete" class="flex gap-3 items-center" data-testid="delete-form">
				<button type="submit" class="button">Delete</button>
				<a class="text-text-muted hover:text-primary-light" href="{base}/thoughts/{data.thought.id}">Cancel</a>
			</form>
		{/if}
	</div>
</section>
