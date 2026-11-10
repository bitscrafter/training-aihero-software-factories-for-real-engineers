# Refund eligibility is decided once, when the Refund Request is submitted

The eligibility rules (refund window, watch time, lessons completed, and the rest) are checked when the learner submits a Refund Request, and never again. When an Admin approves, Cadence records the Refund without re-running them. A learner who was eligible when they asked keeps that, however long the review takes: a request sent on day 13 and reviewed on day 16 is still approvable. Approval is the Admin's judgement on a request that was already eligible, not a second eligibility check.

## Considered Options

- **Re-check eligibility on approval.** Rejected. A slow review would cost the learner a Refund they were promised was possible when they asked, and the request-received email tells them the team reviews every request by hand.
- **Re-check, but freeze the refund window at the submission date.** Rejected. It still lets watching after submitting block the Refund, and splitting the rules into "frozen" and "live" makes them harder to reason about.

## Consequences

- The learner keeps full access while the request is pending, and can keep watching. We accept that a learner gets access and money back until the Admin decides. The Admin screen shows current watch time and lessons completed, so the Admin can weigh it.
- Approval code that skips the eligibility check is deliberate. Only the Refundable Amount rule runs at approval.

## Enforced by

- `app/routes/admin.refund-requests.test.ts`: "approves after the learner's 14-day window has closed".
