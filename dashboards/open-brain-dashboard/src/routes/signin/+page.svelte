<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
	let loading = $state(false);
</script>

<div class="max-w-md mx-auto px-6 py-16">
	<div class="bg-bg-card border border-white/10 rounded-2xl p-8">
		<h1 class="text-2xl font-semibold mb-2">Sign in</h1>
		<p class="text-sm text-text-muted mb-8">
			Paste an access key for your Open Brain server. A read key browses and searches; a write key can capture too.
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
				<div class="text-sm text-red-400">{form.error}</div>
			{/if}

			<button
				type="submit"
				disabled={loading}
				class="w-full py-2.5 rounded-lg bg-primary hover:bg-primary-light disabled:opacity-60 text-white font-medium"
			>
				{loading ? 'Signing in...' : 'Sign in'}
			</button>
		</form>
	</div>
</div>
