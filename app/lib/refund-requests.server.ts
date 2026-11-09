import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "~/db";
import { endEnrollment } from "~/lib/enrollment.server";
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
 * the Admin who resolved each. `refundAmount` is set on approved ones only,
 * `declineNote` on declined ones only.
 */
export function getResolvedRefundRequests() {
  return db
    .select({
      id: refundRequests.id,
      status: refundRequests.status,
      learnerName: users.name,
      courseTitle: courses.title,
      refundAmount: refundRequests.amountRefunded,
      declineNote: refundRequests.declineNote,
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
      declineNote: row.declineNote,
      resolvedBy: row.resolvedByName ? { name: row.resolvedByName } : null,
      resolvedAt: row.resolvedAt,
    }));
}

export type ApproveRefundRequestResult =
  | { outcome: "notFound" }
  | { outcome: "alreadyResolved" }
  | {
      outcome: "approved";
      learner: { name: string; email: string };
      courseTitle: string;
      amountRefunded: number;
    };

/**
 * Approves an open Refund Request: records the Refund at the Refundable
 * Amount, who approved it and when. Eligibility is not checked again.
 * A request that is no longer open is left untouched.
 */
export function approveRefundRequest(
  refundRequestId: number,
  adminUserId: number
): ApproveRefundRequestResult {
  const request = db
    .select({
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
      coursePrice: courses.price,
      amountPaid: purchases.amountPaid,
      country: purchases.country,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refundRequests.id, refundRequestId))
    .get();

  if (!request) return { outcome: "notFound" };

  const amountRefunded = getRefundableAmountForPurchase(
    { amountPaid: request.amountPaid, country: request.country },
    { price: request.coursePrice }
  );

  const approved = db.transaction((tx) => {
    // Only an open request is approved, so two Admins acting at once can't
    // both resolve it.
    const { changes } = tx
      .update(refundRequests)
      .set({
        status: RefundRequestStatus.Approved,
        amountRefunded,
        resolvedAt: new Date().toISOString(),
        resolvedByUserId: adminUserId,
      })
      .where(
        and(
          eq(refundRequests.id, refundRequestId),
          eq(refundRequests.status, RefundRequestStatus.Requested)
        )
      )
      .run();
    if (changes === 0) return false;

    endEnrollment(request.learnerId, request.courseId, tx);
    return true;
  });

  if (!approved) return { outcome: "alreadyResolved" };

  return {
    outcome: "approved",
    learner: { name: request.learnerName, email: request.learnerEmail },
    courseTitle: request.courseTitle,
    amountRefunded,
  };
}

export type DeclineRefundRequestResult =
  | { outcome: "notFound" }
  | { outcome: "alreadyResolved" }
  | {
      outcome: "declined";
      learner: { name: string; email: string };
      courseTitle: string;
      note: string;
    };

/**
 * Declines an open Refund Request with the Admin's note to the learner,
 * recording who declined it and when. The learner's Enrollment is untouched.
 * A request that is no longer open is left untouched.
 */
export function declineRefundRequest(
  refundRequestId: number,
  adminUserId: number,
  note: string
): DeclineRefundRequestResult {
  const request = db
    .select({
      learnerName: users.name,
      learnerEmail: users.email,
      courseTitle: courses.title,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refundRequests.id, refundRequestId))
    .get();

  if (!request) return { outcome: "notFound" };

  // Only an open request is declined, so two Admins acting at once can't both
  // resolve it.
  const { changes } = db
    .update(refundRequests)
    .set({
      status: RefundRequestStatus.Declined,
      declineNote: note,
      resolvedAt: new Date().toISOString(),
      resolvedByUserId: adminUserId,
    })
    .where(
      and(
        eq(refundRequests.id, refundRequestId),
        eq(refundRequests.status, RefundRequestStatus.Requested)
      )
    )
    .run();

  if (changes === 0) return { outcome: "alreadyResolved" };

  return {
    outcome: "declined",
    learner: { name: request.learnerName, email: request.learnerEmail },
    courseTitle: request.courseTitle,
    note,
  };
}

export function countOpenRefundRequests(): number {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(refundRequests)
    .where(eq(refundRequests.status, RefundRequestStatus.Requested))
    .get();
  return result?.count ?? 0;
}
