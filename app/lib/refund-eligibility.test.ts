import { describe, it, expect } from "vitest";
import {
  checkRefundEligibility,
  getRefundableAmount,
  getRefundLimitWarning,
  type RefundFacts,
} from "./refund-eligibility";

// Dates are built in local time: the window is counted in whole local days.
const PURCHASED_AT = new Date(2026, 2, 1, 10, 0); // 1 March 2026, 10:00
const TODAY = new Date(2026, 2, 5, 12, 0); // well inside the window

/** A purchase that passes every rule, unless a test overrides a fact. */
function facts(overrides: Partial<RefundFacts> = {}): RefundFacts {
  return {
    purchasedAt: PURCHASED_AT,
    amountPaid: 4900,
    listPrice: 4900,
    purchasingPowerDiscountApplied: false,
    secondsWatched: 0,
    lessonsCompleted: 0,
    totalLessons: 10,
    hasFilledSeat: false,
    hasOpenRefundRequest: false,
    hasResolvedRefundRequest: false,
    approvedRefundCount: 0,
    ...overrides,
  };
}

describe("checkRefundEligibility", () => {
  it("is eligible on the purchase day, for the list price, until day 14", () => {
    expect(
      checkRefundEligibility(facts(), new Date(2026, 2, 1, 18, 0))
    ).toEqual({
      eligible: true,
      refundableAmount: 4900,
      lastDayOfWindow: "2026-03-15",
    });
  });

  it("is still eligible late in the evening of day 14", () => {
    const today = new Date(2026, 2, 15, 23, 30);
    expect(checkRefundEligibility(facts(), today)).toMatchObject({
      eligible: true,
    });
  });

  it("refuses on day 15, because the window has closed", () => {
    const today = new Date(2026, 2, 16, 0, 5);
    expect(checkRefundEligibility(facts(), today)).toEqual({
      eligible: false,
      failedRule: "refundWindow",
      message: "The 14-day refund window has closed.",
    });
  });

  it("refuses on a date before the purchase day", () => {
    const today = new Date(2026, 1, 28, 23, 0);
    expect(checkRefundEligibility(facts(), today)).toMatchObject({
      eligible: false,
      failedRule: "refundWindow",
    });
  });

  it("is eligible with just under 2 hours watched", () => {
    expect(
      checkRefundEligibility(facts({ secondsWatched: 2 * 60 * 60 - 1 }), TODAY)
    ).toMatchObject({ eligible: true });
  });

  it("refuses once exactly 2 hours have been watched", () => {
    expect(
      checkRefundEligibility(facts({ secondsWatched: 2 * 60 * 60 }), TODAY)
    ).toEqual({
      eligible: false,
      failedRule: "watchTime",
      message: "You have watched too much of this course to get a refund.",
    });
  });

  it("is eligible with 49% of the lessons completed", () => {
    expect(
      checkRefundEligibility(
        facts({ lessonsCompleted: 49, totalLessons: 100 }),
        TODAY
      )
    ).toMatchObject({ eligible: true });
  });

  it("refuses once half the lessons are completed", () => {
    expect(
      checkRefundEligibility(
        facts({ lessonsCompleted: 50, totalLessons: 100 }),
        TODAY
      )
    ).toEqual({
      eligible: false,
      failedRule: "lessonsCompleted",
      message: "You have completed too much of this course to get a refund.",
    });
  });

  it("is eligible for a course with no lessons", () => {
    expect(
      checkRefundEligibility(
        facts({ lessonsCompleted: 0, totalLessons: 0 }),
        TODAY
      )
    ).toMatchObject({ eligible: true });
  });

  it("refuses a purchase with a filled Seat", () => {
    expect(
      checkRefundEligibility(facts({ hasFilledSeat: true }), TODAY)
    ).toEqual({
      eligible: false,
      failedRule: "filledSeat",
      message: "A purchase with a filled Seat cannot be refunded.",
    });
  });

  it("refuses while a Refund Request is already open on the purchase", () => {
    expect(
      checkRefundEligibility(facts({ hasOpenRefundRequest: true }), TODAY)
    ).toEqual({
      eligible: false,
      failedRule: "openRefundRequest",
      message: "You already have a request open on this purchase.",
    });
  });

  it("refuses a purchase whose Refund Request was already resolved", () => {
    expect(
      checkRefundEligibility(facts({ hasResolvedRefundRequest: true }), TODAY)
    ).toEqual({
      eligible: false,
      failedRule: "resolvedRefundRequest",
      message:
        "This purchase already had a Refund Request, and that decision is final.",
    });
  });

  it("is eligible after 2 approved Refunds for the course", () => {
    expect(
      checkRefundEligibility(facts({ approvedRefundCount: 2 }), TODAY)
    ).toMatchObject({ eligible: true });
  });

  it("refuses once the student has had 3 approved Refunds for the course", () => {
    expect(
      checkRefundEligibility(facts({ approvedRefundCount: 3 }), TODAY)
    ).toEqual({
      eligible: false,
      failedRule: "refundLimit",
      message:
        "You have already had 3 Refunds for this course, so this purchase can't be refunded.",
    });
  });

  it("reports an open request before a resolved one", () => {
    expect(
      checkRefundEligibility(
        facts({ hasOpenRefundRequest: true, hasResolvedRefundRequest: true }),
        TODAY
      )
    ).toMatchObject({ failedRule: "openRefundRequest" });
  });

  it("reports a resolved request before a filled Seat", () => {
    expect(
      checkRefundEligibility(
        facts({ hasResolvedRefundRequest: true, hasFilledSeat: true }),
        TODAY
      )
    ).toMatchObject({ failedRule: "resolvedRefundRequest" });
  });

  it("reports a resolved request before the Refund limit, and the limit before a filled Seat", () => {
    expect(
      checkRefundEligibility(
        facts({ hasResolvedRefundRequest: true, approvedRefundCount: 3 }),
        TODAY
      )
    ).toMatchObject({ failedRule: "resolvedRefundRequest" });
    expect(
      checkRefundEligibility(
        facts({ approvedRefundCount: 3, hasFilledSeat: true }),
        TODAY
      )
    ).toMatchObject({ failedRule: "refundLimit" });
  });

  it("reports the first failing rule when several fail", () => {
    const everythingFails = facts({
      hasOpenRefundRequest: true,
      hasFilledSeat: true,
      secondsWatched: 3 * 60 * 60,
      lessonsCompleted: 10,
    });
    const afterTheWindow = new Date(2026, 3, 1, 12, 0);

    expect(
      checkRefundEligibility(everythingFails, afterTheWindow)
    ).toMatchObject({ failedRule: "openRefundRequest" });
    expect(
      checkRefundEligibility(
        { ...everythingFails, hasOpenRefundRequest: false },
        afterTheWindow
      )
    ).toMatchObject({ failedRule: "filledSeat" });
    expect(
      checkRefundEligibility(
        {
          ...everythingFails,
          hasOpenRefundRequest: false,
          hasFilledSeat: false,
        },
        afterTheWindow
      )
    ).toMatchObject({ failedRule: "refundWindow" });
    expect(
      checkRefundEligibility(
        {
          ...everythingFails,
          hasOpenRefundRequest: false,
          hasFilledSeat: false,
        },
        TODAY
      )
    ).toMatchObject({ failedRule: "watchTime" });
  });

  it("refunds the amount paid when a purchasing-power discount applied", () => {
    expect(
      checkRefundEligibility(
        facts({
          amountPaid: 2450,
          listPrice: 4900,
          purchasingPowerDiscountApplied: true,
        }),
        TODAY
      )
    ).toMatchObject({ eligible: true, refundableAmount: 2450 });
  });

  it("refunds the list price, not the amount paid, without a discount", () => {
    expect(
      checkRefundEligibility(
        facts({ amountPaid: 3900, listPrice: 4900 }),
        TODAY
      )
    ).toMatchObject({ eligible: true, refundableAmount: 4900 });
  });
});

describe("getRefundLimitWarning", () => {
  it("has no warning below 3 approved Refunds", () => {
    expect(getRefundLimitWarning(0)).toBeNull();
    expect(getRefundLimitWarning(2)).toBeNull();
  });

  it("warns at and above 3 approved Refunds", () => {
    const warning =
      "You have already had 3 Refunds for this course, so this purchase can't be refunded.";
    expect(getRefundLimitWarning(3)).toBe(warning);
    expect(getRefundLimitWarning(4)).toBe(warning);
  });
});

describe("getRefundableAmount", () => {
  it("is the amount paid for a purchasing-power price", () => {
    expect(
      getRefundableAmount({
        amountPaid: 2450,
        listPrice: 4900,
        purchasingPowerDiscountApplied: true,
      })
    ).toBe(2450);
  });

  it("is the list price, not the amount paid, without a discount", () => {
    expect(
      getRefundableAmount({
        amountPaid: 3900,
        listPrice: 4900,
        purchasingPowerDiscountApplied: false,
      })
    ).toBe(4900);
  });

  it("does not depend on eligibility: a closed window still has an amount", () => {
    expect(
      getRefundableAmount(
        facts({ purchasedAt: new Date(2020, 0, 1), secondsWatched: 99999 })
      )
    ).toBe(4900);
  });
});
