import { asc, desc, eq, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "~/db";
import {
  courses,
  purchases,
  refundRequests,
  RefundRequestStatus,
  users,
} from "~/db/schema";
import {
  getCourseUsage,
  getRefundableAmountForPurchase,
} from "~/lib/refund-eligibility.server";

/**
 * Open Refund Requests, oldest first, each with what an Admin needs to decide
 * on it. `refundAmount` is what approval would record.
 */
export function getOpenRefundRequests() {
  return db
    .select({
      id: refundRequests.id,
      reason: refundRequests.reason,
      requestedAt: refundRequests.requestedAt,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
      coursePrice: courses.price,
      purchasedAt: purchases.createdAt,
      amountPaid: purchases.amountPaid,
      country: purchases.country,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refundRequests.status, RefundRequestStatus.Requested))
    .orderBy(asc(refundRequests.requestedAt), asc(refundRequests.id))
    .all()
    .map((row) => ({
      id: row.id,
      learner: { name: row.learnerName, email: row.learnerEmail },
      courseTitle: row.courseTitle,
      requestedAt: row.requestedAt,
      purchasedAt: row.purchasedAt,
      amountPaid: row.amountPaid,
      refundAmount: getRefundableAmountForPurchase(
        { amountPaid: row.amountPaid, country: row.country },
        { price: row.coursePrice }
      ),
      ...getCourseUsage(row.learnerId, row.courseId),
      reason: row.reason,
    }));
}

const resolvers = alias(users, "resolvers");

/**
 * Approved and declined Refund Requests, most recently resolved first, with
 * the Admin who resolved each. `refundAmount` is set on approved ones only.
 */
export function getResolvedRefundRequests() {
  return db
    .select({
      id: refundRequests.id,
      status: refundRequests.status,
      learnerName: users.name,
      courseTitle: courses.title,
      refundAmount: refundRequests.amountRefunded,
      // The decline note joins here once declining exists (#16).
      resolvedAt: refundRequests.resolvedAt,
      resolvedByName: resolvers.name,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .leftJoin(resolvers, eq(refundRequests.resolvedByUserId, resolvers.id))
    .where(ne(refundRequests.status, RefundRequestStatus.Requested))
    .orderBy(desc(refundRequests.resolvedAt), desc(refundRequests.id))
    .all()
    .map((row) => ({
      id: row.id,
      status: row.status,
      learner: { name: row.learnerName },
      courseTitle: row.courseTitle,
      refundAmount: row.refundAmount,
      resolvedBy: row.resolvedByName ? { name: row.resolvedByName } : null,
      resolvedAt: row.resolvedAt,
    }));
}

export function countOpenRefundRequests(): number {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(refundRequests)
    .where(eq(refundRequests.status, RefundRequestStatus.Requested))
    .get();
  return result?.count ?? 0;
}
