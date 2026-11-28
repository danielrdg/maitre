// Characters outside text (file names, check names, logins, minutes) may not bring to a screen or a prompt:
// C0 and C1 controls, bidi overrides and marks, zero-width characters, and line or paragraph separators.
const INVISIBLE = '\\u200b-\\u200f\\u061c\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069';

// For one line of text.
export const UNSAFE_LINE = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${INVISIBLE}]`, 'g');
// For a body of text: tabs and newlines stay.
export const UNSAFE_BODY = new RegExp(`[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f${INVISIBLE}]`, 'g');
