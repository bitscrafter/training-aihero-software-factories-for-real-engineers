import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  lessonProgress,
  lessons,
  LessonProgressStatus,
  modules,
  purchases,
  refunds,
  RefundStatus,
  videoWatchEvents,
} from "~/db/schema";
import { getDiscountForCountry } from "~/lib/ppp";
import type { RefundFacts } from "~/lib/refund-eligibility";

/**
 * Reads, for a learner's latest purchase of a course, the facts that
 * `checkRefundEligibility` decides on. Returns null if the learner has not
 * bought the course.
 */
export function getRefundFacts(
  userId: number,
  course: { id: number; price: number }
): { purchaseId: number; facts: RefundFacts } | null {
  const purchase = db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, course.id)))
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();

  if (!purchase) return null;

  const lessonIds = getLessonIds(course.id);

  return {
    purchaseId: purchase.id,
    facts: {
      purchasedAt: new Date(purchase.createdAt),
      amountPaid: purchase.amountPaid,
      listPrice: course.price,
      purchasingPowerDiscountApplied:
        getDiscountForCountry(purchase.country) > 0,
      secondsWatched: getSecondsWatched(userId, lessonIds),
      lessonsCompleted: getCompletedLessonCount(userId, lessonIds),
      totalLessons: lessonIds.length,
      isClaimedTeamSeat: isClaimedTeamSeat(purchase.id),
      hasOpenRefundRequest: hasOpenRefundRequest(purchase.id),
    },
  };
}

function getLessonIds(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

// The furthest position reached in each lesson, summed across the course.
function getSecondsWatched(userId: number, lessonIds: number[]): number {
  if (lessonIds.length === 0) return 0;

  return db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all()
    .reduce((total, row) => total + row.furthest, 0);
}

function getCompletedLessonCount(userId: number, lessonIds: number[]): number {
  if (lessonIds.length === 0) return 0;

  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return result?.count ?? 0;
}

function isClaimedTeamSeat(purchaseId: number): boolean {
  const claimed = db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt))
    )
    .get();
  return claimed !== undefined;
}

function hasOpenRefundRequest(purchaseId: number): boolean {
  const open = db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        eq(refunds.status, RefundStatus.Requested)
      )
    )
    .get();
  return open !== undefined;
}
