import { and, eq } from "drizzle-orm";
import { db } from "~/db";
import { enrollments } from "~/db/schema";

// ─── Enrollment ───
// The one place that answers "is this learner enrolled in this course?" and
// that enrolls them. A learner has at most one Enrollment per course.
//
// Uses positional parameters (project convention).

export type Enrollment = typeof enrollments.$inferSelect;

export function findEnrollment(
  userId: number,
  courseId: number
): Enrollment | undefined {
  return db
    .select()
    .from(enrollments)
    .where(
      and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
    )
    .get();
}

export function isEnrolled(userId: number, courseId: number): boolean {
  return findEnrollment(userId, courseId) !== undefined;
}

/**
 * Enrolls the learner in the course. Enrolling someone who is already
 * enrolled returns their existing Enrollment rather than creating another.
 */
export function enroll(userId: number, courseId: number): Enrollment {
  const existing = findEnrollment(userId, courseId);
  if (existing) return existing;

  return db.insert(enrollments).values({ userId, courseId }).returning().get();
}
