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

const resolvers = alias(users, "resolvers");

/**
 * Refund Requests with the purchase each is about, the learner who bought it,
 * the course bought, and the Admin who resolved it (null while open).
 */
function selectRefundRequests() {
  return db
    .select({
      request: {
        id: refundRequests.id,
        status: refundRequests.status,
        reason: refundRequests.reason,
        requestedAt: refundRequests.requestedAt,
        amountRefunded: refundRequests.amountRefunded,
        declineNote: refundRequests.declineNote,
        resolvedAt: refundRequests.resolvedAt,
      },
      purchase: {
        createdAt: purchases.createdAt,
        amountPaid: purchases.amountPaid,
        country: purchases.country,
      },
      learner: { id: users.id, name: users.name, email: users.email },
      course: { id: courses.id, title: courses.title, price: courses.price },
      resolvedBy: { name: resolvers.name },
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .leftJoin(resolvers, eq(refundRequests.resolvedByUserId, resolvers.id));
}

function findRefundRequest(refundRequestId: number) {
  return selectRefundRequests()
    .where(eq(refundRequests.id, refundRequestId))
    .get();
}

/**
 * Open Refund Requests, oldest first, each with what an Admin needs to decide
 * on it. `refundAmount` is what approval would record.
 */
export function getOpenRefundRequests() {
  return selectRefundRequests()
    .where(eq(refundRequests.status, RefundRequestStatus.Requested))
    .orderBy(asc(refundRequests.requestedAt), asc(refundRequests.id))
    .all()
    .map((row) => ({
      id: row.request.id,
      learner: { name: row.learner.name, email: row.learner.email },
      courseTitle: row.course.title,
      requestedAt: row.request.requestedAt,
      purchasedAt: row.purchase.createdAt,
      amountPaid: row.purchase.amountPaid,
      refundAmount: getRefundableAmountForPurchase(row.purchase, row.course),
      ...getCourseUsage(row.learner.id, row.course.id),
      reason: row.request.reason,
    }));
}

/**
 * Approved and declined Refund Requests, most recently resolved first, with
 * the Admin who resolved each. `refundAmount` is set on approved ones only,
 * `declineNote` on declined ones only.
 */
export function getResolvedRefundRequests() {
  return selectRefundRequests()
    .where(ne(refundRequests.status, RefundRequestStatus.Requested))
    .orderBy(desc(refundRequests.resolvedAt), desc(refundRequests.id))
    .all()
    .map((row) => ({
      id: row.request.id,
      status: row.request.status,
      learner: { name: row.learner.name },
      courseTitle: row.course.title,
      refundAmount: row.request.amountRefunded,
      declineNote: row.request.declineNote,
      resolvedBy: row.resolvedBy,
      resolvedAt: row.request.resolvedAt,
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
  const request = findRefundRequest(refundRequestId);

  if (!request) return { outcome: "notFound" };

  const amountRefunded = getRefundableAmountForPurchase(
    request.purchase,
    request.course
  );

  const approved = db.transaction((tx) => {
    const resolved = resolveIfStillOpen(
      refundRequestId,
      adminUserId,
      { status: RefundRequestStatus.Approved, amountRefunded },
      tx
    );
    if (resolved) endEnrollment(request.learner.id, request.course.id, tx);
    return resolved;
  });

  if (!approved) return { outcome: "alreadyResolved" };

  return {
    outcome: "approved",
    learner: { name: request.learner.name, email: request.learner.email },
    courseTitle: request.course.title,
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
  const request = findRefundRequest(refundRequestId);

  if (!request) return { outcome: "notFound" };

  const declined = resolveIfStillOpen(refundRequestId, adminUserId, {
    status: RefundRequestStatus.Declined,
    declineNote: note,
  });

  if (!declined) return { outcome: "alreadyResolved" };

  return {
    outcome: "declined",
    learner: { name: request.learner.name, email: request.learner.email },
    courseTitle: request.course.title,
    note,
  };
}

/** `db` itself, or the transaction handed to a `db.transaction` callback. */
type Executor = Pick<typeof db, "update">;

/**
 * Records the resolution, with who resolved it and when, but only while the
 * request is still open, so two Admins acting at once can't both resolve it.
 * Returns whether it was resolved.
 */
function resolveIfStillOpen(
  refundRequestId: number,
  adminUserId: number,
  resolution:
    | { status: RefundRequestStatus.Approved; amountRefunded: number }
    | { status: RefundRequestStatus.Declined; declineNote: string },
  executor: Executor = db
): boolean {
  const { changes } = executor
    .update(refundRequests)
    .set({
      ...resolution,
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
  return changes > 0;
}

export function countOpenRefundRequests(): number {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(refundRequests)
    .where(eq(refundRequests.status, RefundRequestStatus.Requested))
    .get();
  return result?.count ?? 0;
}
