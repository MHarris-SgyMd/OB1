<script lang="ts">
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
	// A browser drops one line break straight after <textarea>: one is put there, so a kept text that starts with a break keeps it.
	const field = $derived(`\n${form?.content ?? ''}`);
</script>

<svelte:head><title>Capture · Open Brain</title></svelte:head>

<section class="space-y-6">
	<h1 class="text-xl font-semibold">Capture a thought</h1>

	<!-- Multipart: the text is posted as it is, not percent-encoded, as the edit page posts it. -->
	<form method="POST" action="?/capture" enctype="multipart/form-data" class="bg-bg-card border border-white/10 rounded-xl p-5 space-y-3 text-sm" data-testid="capture-form">
		<label class="flex flex-col gap-1">The thought
			<textarea name="content" rows="10" class="field whitespace-pre-wrap" required value={field} aria-invalid={form?.error ? 'true' : undefined} aria-describedby={form?.error ? 'capture-error' : 'capture-help'}></textarea>
		</label>
		<p class="text-text-muted" id="capture-help">
			Write it so it makes sense on its own when it is found later. The brain embeds it for search and extracts its type, topics and people. Its source is recorded as <span class="font-mono">dashboard</span>.
		</p>
		{#if form?.error}
			<p class="text-amber-300" role="alert" id="capture-error" data-testid="capture-error">{form.error}</p>
		{/if}
		<button type="submit" class="button">Capture</button>
	</form>
</section>
