# A Cancellation ends the Enrollment without deleting it, and keeps lesson progress

An approved Refund Request always causes a Cancellation. We record the Cancellation by marking the Enrollment as ended rather than deleting the row, and we leave the student's lesson progress untouched. Deleting is irreversible: it would erase when the student enrolled and whether they completed the course. It would also leave nothing to show that access ended because of a Refund. Keeping the row preserves that history for Admins and instructor analytics. It also means a student who buys the course again picks up where they left off.

## Considered Options

- **Delete the Enrollment row.** Rejected. Every existing "is enrolled?" check would keep working unchanged, but the history would be lost and could not be recovered.
- **Delete the Enrollment and the lesson progress.** Rejected. It punishes a student who comes back, and the Refund already returns the money, so wiping their work as well gains nothing.

## Consequences

- Anything that asks "is this student enrolled?" or counts enrolled students must now ignore ended Enrollments. That includes access checks, the dashboard, the course list, instructor student lists and instructor analytics. Missing one of these would let a refunded student keep access, or inflate instructor numbers.
- Learning state is shared across Enrollments, not separate for each one. Lesson progress, video positions, quiz attempts, comments and the course rating are all stored per student and lesson, quiz or course, not per Enrollment or Purchase. So they survive a Cancellation with no extra work, and the student's comments and rating stay visible to others.
- When a student buys again, their old Enrollment is reopened rather than a second one being created. A student and a course never have more than one Enrollment, and the returning student gets everything back: completed lessons, where they stopped in each video, quiz results and the completed date.
- Because progress is shared, the refund limits on watch time and lessons completed count everything the student has ever done in the course, not just what they did since the latest purchase. Otherwise a student could take most of a course across repeated buy-and-refund rounds. Only the 14-day window restarts with each new purchase.

## Enforced by

- `app/routes/admin.refund-requests.test.ts`: "ends the student's Enrollment without deleting it, so they lose lesson access".
- `app/routes/buying-again.test.ts`: buying again or redeeming a coupon reopens the same Enrollment, and learning state comes back.
- `app/routes/ended-enrollments.test.ts`: every enrollment list and count ignores ended Enrollments.
