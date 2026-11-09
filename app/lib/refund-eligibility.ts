/** What we know about a purchase when deciding whether it may get a Refund Request. */
export type RefundFacts = {
  purchasedAt: Date;
  amountPaid: number;
  listPrice: number;
  purchasingPowerDiscountApplied: boolean;
  secondsWatched: number;
  lessonsCompleted: number;
  totalLessons: number;
  isClaimedTeamSeat: boolean;
  hasOpenRefundRequest: boolean;
};

export type RefundRule =
  | "openRefundRequest"
  | "claimedTeamSeat"
  | "refundWindow"
  | "watchTime"
  | "lessonsCompleted";

export type RefundEligibility =
  | { eligible: true; refundableAmount: number; lastDayOfWindow: string }
  | { eligible: false; failedRule: RefundRule; message: string };

const REFUND_WINDOW_DAYS = 14;
const MAX_WATCHED_SECONDS = 2 * 60 * 60;
const MAX_COMPLETED_SHARE = 0.5;

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

// A seat bought on a team licence and since claimed belongs to the team; the
// learner cannot hand it back on their own.
function isNotClaimedTeamSeat(facts: RefundFacts): boolean {
  return !facts.isClaimedTeamSeat;
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
    name: "claimedTeamSeat",
    passes: isNotClaimedTeamSeat,
    message: "A claimed team seat cannot be refunded.",
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
    // A purchasing-power price is given back at what was paid; otherwise the
    // course's list price.
    refundableAmount: facts.purchasingPowerDiscountApplied
      ? facts.amountPaid
      : facts.listPrice,
    lastDayOfWindow: lastDayOfWindow(facts.purchasedAt),
  };
}
