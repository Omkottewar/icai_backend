// Server-side password policy. Auth0 also enforces a policy on /dbconnections/signup
// (configured in Authentication → Database → Password Policy), but we validate
// at our edge too so:
//   1. Users get instant feedback without a round-trip to Auth0.
//   2. The Auth0 dashboard policy can drift; this is the floor we never go under.
//
// If you change MIN_LENGTH here, mirror the matching client-side hint in
// src/pages/auth/SignupPage.jsx.

export const PASSWORD_MIN_LENGTH = 8;

/** Returns null if ok, or an error message describing what's wrong. */
export function validatePassword(password: string): string | null {
  if (typeof password !== "string") return "Password is required.";
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  // Require at least one letter AND one digit. Symbols are encouraged but
  // not required — Auth0's Fair / Good policy doesn't either.
  if (!/[A-Za-z]/.test(password)) return "Password must contain at least one letter.";
  if (!/\d/.test(password))      return "Password must contain at least one number.";
  return null;
}
