/** What we know about a purchase when deciding whether it may get a Refund Request. */
export type RefundFacts = {
  purchasedAt: Date;
  amountPaid: number;
  listPrice: number;
  purchasingPowerDiscountApplied: boolean;
  secondsWatched: number;
  lessonsCompleted: number;
  totalLessons: number;
  hasFilledSeat: boolean;
  hasOpenRefundRequest: boolean;
  /** An earlier Refund Request on this purchase was approved or declined. */
  hasResolvedRefundRequest: boolean;
  /** Approved Refunds this student has had for this course, on any purchase. */
  approvedRefundCount: number;
};

export type RefundRule =
  | "openRefundRequest"
  | "resolvedRefundRequest"
  | "refundLimit"
  | "filledSeat"
  | "refundWindow"
  | "watchTime"
  | "lessonsCompleted";

export type RefundEligibility =
  | { eligible: true; refundableAmount: number; lastDayOfWindow: string }
  | { eligible: false; failedRule: RefundRule; message: string };

const REFUND_WINDOW_DAYS = 14;
const MAX_WATCHED_SECONDS = 2 * 60 * 60;
const MAX_COMPLETED_SHARE = 0.5;
const MAX_APPROVED_REFUNDS_PER_COURSE = 3;

// Whole local days as "YYYY-MM-DD", which compare correctly as strings.
function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

function lastDayOfWindow(purchasedAt: Date): string {
  const deadline = new Date(purchasedAt);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(deadline);
}

// ─── Rules ───
// Each rule answers "does this purchase pass?". They are kept separate so each
// one can be read, named and changed on its own.

function hasNoOpenRefundRequest(facts: RefundFacts): boolean {
  return !facts.hasOpenRefundRequest;
}

// A purchase gets at most one Refund Request, and its resolution is final.
function hasNoResolvedRefundRequest(facts: RefundFacts): boolean {
  return !facts.hasResolvedRefundRequest;
}

// Only approved Refunds count, per student per course. Declined requests don't.
function isUnderRefundLimit(
  facts: Pick<RefundFacts, "approvedRefundCount">
): boolean {
  return facts.approvedRefundCount < MAX_APPROVED_REFUNDS_PER_COURSE;
}

const REFUND_LIMIT_MESSAGE = `You have already had ${MAX_APPROVED_REFUNDS_PER_COURSE} Refunds for this course, so this purchase can't be refunded.`;

// A Seat on a Team's Purchase, once filled, belongs to the Team; the student
// cannot hand it back on their own.
function hasNoFilledSeat(facts: RefundFacts): boolean {
  return !facts.hasFilledSeat;
}

// The window is counted in whole local days, not hours: someone who buys at
// 23:00 still gets the whole of their fourteenth day.
function isWithinRefundWindow(facts: RefundFacts, today: Date): boolean {
  const todayDay = calendarDay(today);
  return (
    todayDay >= calendarDay(facts.purchasedAt) &&
    todayDay <= lastDayOfWindow(facts.purchasedAt)
  );
}

// Watched time is the furthest position reached in each lesson, summed.
function isUnderWatchLimit(facts: RefundFacts): boolean {
  return facts.secondsWatched < MAX_WATCHED_SECONDS;
}

// A course with no lessons has nothing to complete, so it always passes.
function isUnderCompletionLimit(facts: RefundFacts): boolean {
  if (facts.totalLessons === 0) return true;
  return facts.lessonsCompleted / facts.totalLessons < MAX_COMPLETED_SHARE;
}

// Checked in this order; the first rule that fails is the one reported.
const RULES: ReadonlyArray<{
  name: RefundRule;
  passes: (facts: RefundFacts, today: Date) => boolean;
  message: string;
}> = [
  {
    name: "openRefundRequest",
    passes: hasNoOpenRefundRequest,
    message: "You already have a request open on this purchase.",
  },
  {
    name: "resolvedRefundRequest",
    passes: hasNoResolvedRefundRequest,
    message:
      "This purchase already had a Refund Request, and that decision is final.",
  },
  {
    name: "refundLimit",
    passes: isUnderRefundLimit,
    message: REFUND_LIMIT_MESSAGE,
  },
  {
    name: "filledSeat",
    passes: hasNoFilledSeat,
    message: "A purchase with a filled Seat cannot be refunded.",
  },
  {
    name: "refundWindow",
    passes: isWithinRefundWindow,
    message: `The ${REFUND_WINDOW_DAYS}-day refund window has closed.`,
  },
  {
    name: "watchTime",
    passes: isUnderWatchLimit,
    message: "You have watched too much of this course to get a refund.",
  },
  {
    name: "lessonsCompleted",
    passes: isUnderCompletionLimit,
    message: "You have completed too much of this course to get a refund.",
  },
];

/**
 * The Refund a purchase would get, in cents. This is the single rule for the
 * amount: the eligibility verdict, the Admin Refund Requests screen and
 * approval all use it. It does not check eligibility.
 */
export function getRefundableAmount(
  facts: Pick<
    RefundFacts,
    "amountPaid" | "listPrice" | "purchasingPowerDiscountApplied"
  >
): number {
  // A purchasing-power price is given back at what was paid; otherwise the
  // course's list price.
  return facts.purchasingPowerDiscountApplied
    ? facts.amountPaid
    : facts.listPrice;
}

/**
 * The warning for the purchase page, shown before buying, when a student with
 * this many approved Refunds for the course could not get one on a new
 * purchase of it. Null below the Refund limit.
 */
export function getRefundLimitWarning(
  approvedRefundCount: number
): string | null {
  return isUnderRefundLimit({ approvedRefundCount })
    ? null
    : REFUND_LIMIT_MESSAGE;
}

export function checkRefundEligibility(
  facts: RefundFacts,
  today: Date
): RefundEligibility {
  const failed = RULES.find((rule) => !rule.passes(facts, today));
  if (failed) {
    return {
      eligible: false,
      failedRule: failed.name,
      message: failed.message,
    };
  }

  return {
    eligible: true,
    refundableAmount: getRefundableAmount(facts),
    lastDayOfWindow: lastDayOfWindow(facts.purchasedAt),
  };
}
