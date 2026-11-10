# Cadence

Cadence is a course platform: instructors publish video courses, and learners buy and take them.

## Language

### People

**Learner**:
A person who buys and takes courses.
_Avoid_: Student, User (for this role)

**Instructor**:
A person who publishes courses and owns their content and analytics.
_Avoid_: Teacher, Author

**Admin**:
A person who runs the Cadence platform, such as resolving Refund Requests. Not the same as a Team Admin.
_Avoid_: Staff, Support, Operator

### Buying

**Purchase**:
A payment for a course, made either by a learner for themselves or by a Team Admin for a Team's Seats.
_Avoid_: Order, Transaction

**Purchasing-Power Price**:
A course price lowered for the buyer's country.
_Avoid_: PPP (outside code), Regional discount

### Teams

**Team**:
A group of learners whose Seats were bought together by a Team Admin.

**Team Admin**:
The person who buys Seats for a Team and hands out its Coupons. Buying Seats doesn't give them an Enrollment.
_Avoid_: Team buyer, Team owner

**Seat**:
One place in a course bought on a Team's Purchase, filled when a learner redeems its Coupon.
_Avoid_: Licence

**Coupon**:
The code that lets one learner redeem one Seat.
_Avoid_: Voucher, Invite link

**Redeem**:
To use a Coupon to fill a Seat, which gives the learner an Enrollment.
_Avoid_: Claim

### Getting money back

**Refund Request**:
A learner's ask, with a reason, to get back what they paid for a course; an Admin approves or declines it. A Purchase gets at most one, and its resolution is final.
_Avoid_: Cancel my purchase, Cancellation, Reversal, Chargeback

**Refund**:
Money given back to a learner for a Purchase, as the outcome of an approved Refund Request. Always comes with a Cancellation.
_Avoid_: Reversal, Chargeback

**Refundable Amount**:
What an approved Refund Request gives back for a Purchase.

**Refund Window**:
The days after a Purchase during which a Refund Request can be made. Each new Purchase starts a new one.

**Refund Limit**:
The most Refunds a learner can get for one course.

**Chargeback**:
A charge the cardholder disputes with their bank, which pulls the money back without going through us. Distinct from a Refund; not handled by Cadence yet.

### Taking courses

**Enrollment**:
A learner's access to a course, either active or ended. A learner has at most one per course.

**Cancellation**:
The end of a learner's Enrollment in a course, so they lose access to it. Their learning progress is kept, and returns if they buy the course again.
_Avoid_: Cancel my purchase (for the request), Revocation
