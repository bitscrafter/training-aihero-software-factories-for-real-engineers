import { and, eq, isNull } from "drizzle-orm";
import { db } from "~/db";
import { enrollments } from "~/db/schema";

// ─── Enrollment ───
// The one place that answers "is this learner enrolled in this course?" and
// that enrolls them. A learner has at most one Enrollment per course.
//
// An Enrollment with an "ended at" has had a Cancellation: it is kept, never
// deleted, but no longer counts as enrolled (ADR 0001).
//
// Uses positional parameters (project convention).

export type Enrollment = typeof enrollments.$inferSelect;

/** `db` itself, or the transaction handed to a `db.transaction` callback. */
type Executor = Pick<typeof db, "update">;

/** The learner's active Enrollment in the course, if any. */
export function findEnrollment(
  userId: number,
  courseId: number
): Enrollment | undefined {
  return db
    .select()
    .from(enrollments)
    .where(
      and(
        eq(enrollments.userId, userId),
        eq(enrollments.courseId, courseId),
        isNull(enrollments.endedAt)
      )
    )
    .get();
}

export function isEnrolled(userId: number, courseId: number): boolean {
  return findEnrollment(userId, courseId) !== undefined;
}

/**
 * Enrolls the learner in the course. Enrolling someone who is already
 * enrolled returns their existing Enrollment rather than creating another.
 * Enrolling someone whose Enrollment has ended reopens it, keeping when they
 * first enrolled and when they completed the course (ADR 0001).
 */
export function enroll(userId: number, courseId: number): Enrollment {
  const existing = db
    .select()
    .from(enrollments)
    .where(
      and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
    )
    .get();

  if (!existing) {
    return db
      .insert(enrollments)
      .values({ userId, courseId })
      .returning()
      .get();
  }
  if (existing.endedAt === null) return existing;

  return db
    .update(enrollments)
    .set({ endedAt: null })
    .where(eq(enrollments.id, existing.id))
    .returning()
    .get();
}

/**
 * A Cancellation: ends the learner's active Enrollment in the course, keeping
 * the row. Pass the transaction when this is part of a larger write.
 */
export function endEnrollment(
  userId: number,
  courseId: number,
  executor: Executor = db
): void {
  executor
    .update(enrollments)
    .set({ endedAt: new Date().toISOString() })
    .where(
      and(
        eq(enrollments.userId, userId),
        eq(enrollments.courseId, courseId),
        isNull(enrollments.endedAt)
      )
    )
    .run();
}
