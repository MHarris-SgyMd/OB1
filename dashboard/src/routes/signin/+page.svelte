<script lang="ts">
	import { enhance } from '$app/forms';
	import { base } from '$app/paths';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let loading = $state(false);
</script>

<svelte:head><title>Sign in · Open Brain</title></svelte:head>

<div class="max-w-md mx-auto px-6 py-16">
	<div class="bg-bg-card border border-white/10 rounded-2xl p-8">
		<h1 class="text-2xl font-semibold mb-2">Sign in</h1>
		{#if data.refused}
			<div class="text-sm text-red-400 mb-6" role="alert" data-testid="refused">{data.refused}</div>
		{/if}
		{#if data.mode === 'key'}
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
						class="mt-2 w-full field"
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
		{:else if data.mode === 'oauth'}
			<p class="text-sm text-text-muted mb-8">
				This brain signs its operator in through its authorization server. Key sign-in is off here: a configured stack's public origin never offers a key.
			</p>
			<!-- A form, not a link: a hover's preload would start a sign-in, and so could a link planted elsewhere. -->
			<form method="POST" action="{base}/auth/start" data-testid="oauth">
				<button type="submit" class="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-medium">Sign in through the authorization server</button>
			</form>
		{:else if data.mode === 'unavailable'}
			<p class="text-sm text-text-muted" role="alert" data-testid="unavailable">
				Sign-in is unavailable: the authorization server is not answering. Key sign-in is off on this public address whatever the authorization server's state, so that stopping it opens no weaker door. Start it again on the brain's machine (<code>compose up -d --wait auth</code>, with the stack's other files); a loopback-only break-glass sign-in that takes a key while it is down is to come (SMD-3307's second part).
			</p>
		{:else}
			<p class="text-sm text-text-muted" role="alert" data-testid="misconfigured">
				Sign-in is unavailable: this stack is configured with the authorization server (COMPOSE_PROFILES names auth), but the dashboard has no <code>OB1_AUTH_SECRET_GUI</code> or no sound <code>OB1_PUBLIC_ORIGIN</code>. Key sign-in is off here. The operator sets both in <code>deploy/.env</code> and recreates <code>app</code>.
			</p>
		{/if}
	</div>
</div>
