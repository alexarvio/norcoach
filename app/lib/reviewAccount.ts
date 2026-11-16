// The App Review login (16 Nov, Alex): Apple's reviewer can't read our sign-in emails, so this one address signs in with
// a fixed code kept only in the server's settings (REVIEW_CODE), never in the app. Every other address is untouched.
// The account itself is the demo client built by /api/review-account.
export const REVIEW_EMAIL = "review@norcoachapp.com";

export const isReviewEmail = (email: string) => email.trim().toLowerCase() === REVIEW_EMAIL;
