// A GET form's address, holding what is set alone (SMD-2280 PR 2a, shared since
// PR 2b's review pass 1): SvelteKit reads the form with `new FormData(form)`,
// which fires `formdata`, so an empty field (or one of spaces) and a field at
// its default are dropped from the data there — never by disabling a field,
// which lost the focus it had in Firefox and WebKit (PR 2a review pass 2). A
// script-free submit carries every field.

/** The `formdata` handler for a form whose fields default to `defaults` (by name). */
export function tidy(defaults: Record<string, string> = {}) {
	return (e: FormDataEvent) => {
		for (const [k, v] of [...e.formData.entries()]) {
			if (String(v).trim() === '' || defaults[k] === v) e.formData.delete(k);
		}
	};
}
