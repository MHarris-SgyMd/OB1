<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let loading = $state(false);
</script>

<svelte:head><title>Sign in · Open Brain</title></svelte:head>

<div class="max-w-md mx-auto px-6 py-16">
	<div class="bg-bg-card border border-white/10 rounded-2xl p-8">
		<h1 class="text-2xl font-semibold mb-2">Sign in</h1>
		{#if data.offered}
			<p class="text-sm text-text-muted mb-8">
				Paste an access key for this brain. A read key or a write key opens the dashboard; a capture-only key may add thoughts and nothing else, so it is refused here.
			</p>

			<form
				method="POST"
				class="space-y-4"
				use:enhance={() => {
					loading = true;
					return async ({ result, update }) => {
						await update();
						loading = false;
						// The disabled button dropped focus out of the form; a refusal puts it back on the field (review pass 6).
						if (result.type === 'failure') document.getElementById('key')?.focus();
					};
				}}
			>
				<div>
					<label class="text-sm text-text-muted" for="key">Access key</label>
					<input
						id="key"
						name="key"
						type="password"
						autocomplete="current-password"
						required
						aria-invalid={form?.error ? 'true' : undefined}
						aria-describedby={form?.error ? 'key-error' : 'key-help'}
						class="mt-2 w-full bg-bg-elevated border border-white/40 rounded-lg px-3 py-2 focus:outline-none focus:border-primary"
					/>
				</div>

				<p id="key-help" class="text-xs text-text-muted">The raw key <code>keygen.ts</code> printed once when the key was made.</p>

				{#if form?.error}
					<div id="key-error" class="text-sm text-red-400" role="alert">{form.error}</div>
				{/if}

				<button
					type="submit"
					disabled={loading}
					class="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-medium"
				>
					{loading ? 'Signing in…' : 'Sign in'}
				</button>
			</form>
		{:else}
			<p class="text-sm text-text-muted" role="alert">
				Key sign-in is off: this stack is configured with the authorization server (COMPOSE_PROFILES names auth), and its public origin never offers a key. Sign-in through the authorization server, and a loopback-only key sign-in for when it is down, are still to come (SMD-2280).
			</p>
		{/if}
	</div>
</div>
