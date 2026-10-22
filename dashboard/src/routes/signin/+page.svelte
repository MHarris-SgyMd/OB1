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
					return async ({ update }) => {
						await update();
						loading = false;
					};
				}}
			>
				<div>
					<label class="text-sm text-text-muted" for="key">Access key</label>
					<input
						id="key"
						name="key"
						type="password"
						placeholder="the key keygen.ts printed once"
						autocomplete="current-password"
						required
						class="mt-2 w-full bg-bg-elevated border border-white/10 rounded-lg px-3 py-2 focus:outline-none focus:border-primary"
					/>
				</div>

				{#if form?.error}
					<div class="text-sm text-red-400" role="alert">{form.error}</div>
				{/if}

				<button
					type="submit"
					disabled={loading}
					class="w-full py-2.5 rounded-lg bg-primary hover:bg-primary-light disabled:opacity-60 text-white font-medium"
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
