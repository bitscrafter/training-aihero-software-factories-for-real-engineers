import { and, eq, isNull, type SQL } from "drizzle-orm";
import { db } from "~/db";
import { enrollments } from "~/db/schema";

// ─── Enrollment ───
// The one place that answers "is this student enrolled in this course?" and
// that enrolls them. A student has at most one Enrollment per course.
//
// An Enrollment with an "ended at" has had a Cancellation: it is kept, never
// deleted, but no longer counts as enrolled (ADR 0001).
//
// Uses positional parameters.

export type Enrollment = typeof enrollments.$inferSelect;

/** `db` itself, or the transaction handed to a `db.transaction` callback. */
export type Executor = Pick<typeof db, "update">;

/**
 * The condition that keeps only active Enrollments, leaving out ended ones.
 * Every query that lists or counts enrolled students filters with it.
 */
export function isActiveEnrollment(): SQL {
  return isNull(enrollments.endedAt);
}

/** The student's active Enrollment in the course, if any. */
export function findEnrollment(
  userId: number,
  courseId: number
): Enrollment | undefined {
  return lookUpEnrollment(userId, courseId, isActiveEnrollment());
}

/** The student's Enrollment in the course, active or ended, if any. */
function lookUpEnrollment(
  userId: number,
  courseId: number,
  condition?: SQL
): Enrollment | undefined {
  return db
    .select()
    .from(enrollments)
    .where(
      and(
        eq(enrollments.userId, userId),
        eq(enrollments.courseId, courseId),
        condition
      )
    )
    .get();
}

export function isEnrolled(userId: number, courseId: number): boolean {
  return findEnrollment(userId, courseId) !== undefined;
}

/**
 * Enrolls the student in the course. Enrolling someone who is already
 * enrolled returns their existing Enrollment rather than creating another.
 * Enrolling someone whose Enrollment has ended reopens it, keeping when they
 * first enrolled and when they completed the course (ADR 0001).
 */
export function enroll(userId: number, courseId: number): Enrollment {
  const existing = lookUpEnrollment(userId, courseId);

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
 * A Cancellation: ends the student's active Enrollment in the course, keeping
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
        isActiveEnrollment()
      )
    )
    .run();
}
