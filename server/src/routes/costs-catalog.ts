/**
 * The currencies offered before the first FX fetch lands.
 *
 * Held server-side as well as in the client so the dropdown is populated on a
 * fresh install with no network at all - a first-run user who is offline still
 * gets a working selector. The client's own copy carries display names; this one
 * only needs the codes, because the names arrive with the fetched rates.
 */
export const FALLBACK_CURRENCIES_SHARED: Array<{ code: string; name: string }> = [
  { code: 'INR', name: 'Indian Rupee' },
  { code: 'USD', name: 'US Dollar' },
  { code: 'EUR', name: 'Euro' },
  { code: 'GBP', name: 'British Pound' },
  { code: 'AED', name: 'UAE Dirham' },
  { code: 'SGD', name: 'Singapore Dollar' },
  { code: 'JPY', name: 'Japanese Yen' },
  { code: 'CNY', name: 'Chinese Yuan' },
  { code: 'AUD', name: 'Australian Dollar' },
  { code: 'CAD', name: 'Canadian Dollar' },
];
