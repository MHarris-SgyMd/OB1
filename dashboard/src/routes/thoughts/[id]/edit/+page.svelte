<script lang="ts">
	import { base } from '$app/paths';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	// A browser drops one line break straight after <textarea>: one is put there, so a text that starts with a break keeps it (review pass 1).
	const field = $derived(`\n${form?.content ?? data.thought.text ?? ''}`);
</script>

<svelte:head><title>Edit · {data.thought.title} · Open Brain</title></svelte:head>

<section class="space-y-6">
	<header>
		<h1 class="text-xl font-semibold">Edit a thought</h1>
		<p class="text-sm text-text-muted mt-1 [overflow-wrap:anywhere]">
			<a class="hover:text-primary-light" href="{base}/thoughts/{data.thought.id}">{data.thought.title}</a> · <span class="font-mono">{data.thought.id}</span>
		</p>
	</header>

	{#if data.tooLarge}
		<p class="bg-bg-card border border-white/10 rounded-xl p-5 text-sm text-amber-300" role="note" data-testid="too-large">{data.tooLarge}</p>
	{:else}
		<!-- Multipart: the text is posted as it is, not percent-encoded to three bytes a byte for anything not ASCII (review pass 1). -->
		<form method="POST" action="?/save" enctype="multipart/form-data" class="bg-bg-card border border-white/10 rounded-xl p-5 space-y-3 text-sm" data-testid="edit-form">
			<input type="hidden" name="if_unchanged_since" value={form?.since ?? data.thought.updatedAt ?? ''} />
			<label class="flex flex-col gap-1">Its text
				<textarea name="content" rows="16" class="field font-mono whitespace-pre-wrap" required value={field} aria-invalid={form?.error ? 'true' : undefined} aria-describedby={form?.error ? 'edit-error' : 'edit-help'}></textarea>
			</label>
			<p class="text-text-muted" id="edit-help">
				Saving replaces the text and searches find the new one. The audit trail keeps the text it replaced. If the thought changes before you save, the edit is refused rather than overwriting that change.
			</p>
			{#if form?.error}
				<p class="text-amber-300" role="alert" id="edit-error" data-testid="edit-error">{form.error}</p>
			{/if}
			<div class="flex gap-3 items-center">
				<button type="submit" class="button">Save</button>
				<a class="text-text-muted hover:text-primary-light" href="{base}/thoughts/{data.thought.id}">Cancel</a>
			</div>
		</form>
	{/if}
</section>
