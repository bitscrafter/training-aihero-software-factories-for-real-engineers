import { describe, it, expect, beforeEach } from "vitest";
import * as schema from "~/db/schema";
import { useFreshAppDatabase } from "~/test/setup";

type Db = Awaited<ReturnType<typeof useFreshAppDatabase>>;
type EnrollmentModule = typeof import("~/lib/enrollment.server");

let db: Db;
let enrollment: EnrollmentModule;

beforeEach(async () => {
  db = await useFreshAppDatabase();
  enrollment = await import("~/lib/enrollment.server");
});

function seedCourse(slug: string) {
  const instructor = db
    .insert(schema.users)
    .values({
      name: `Instructor of ${slug}`,
      email: `${slug}@example.com`,
      role: schema.UserRole.Instructor,
    })
    .returning()
    .get();
  const category = db
    .insert(schema.categories)
    .values({ name: `Category ${slug}`, slug: `category-${slug}` })
    .returning()
    .get();
  return db
    .insert(schema.courses)
    .values({
      title: slug,
      slug,
      description: "A course",
      salesCopy: `## ${slug}`,
      instructorId: instructor.id,
      categoryId: category.id,
      status: schema.CourseStatus.Published,
    })
    .returning()
    .get();
}

function seedLearner() {
  return db
    .insert(schema.users)
    .values({
      name: "Lena Learner",
      email: "lena@example.com",
      role: schema.UserRole.Student,
    })
    .returning()
    .get();
}

describe("Enrollment", () => {
  it("a learner who never enrolled is not enrolled", () => {
    const course = seedCourse("testing-things");
    const learner = seedLearner();

    expect(enrollment.isEnrolled(learner.id, course.id)).toBe(false);
    expect(enrollment.findEnrollment(learner.id, course.id)).toBeUndefined();
  });

  it("enrolling makes the learner enrolled in that course", () => {
    const course = seedCourse("testing-things");
    const learner = seedLearner();

    const enrolled = enrollment.enroll(learner.id, course.id);

    expect(enrollment.isEnrolled(learner.id, course.id)).toBe(true);
    expect(enrollment.findEnrollment(learner.id, course.id)).toEqual(enrolled);
    expect(enrolled).toMatchObject({ userId: learner.id, courseId: course.id });
  });

  it("enrolling twice leaves the learner with one Enrollment", () => {
    const course = seedCourse("testing-things");
    const learner = seedLearner();

    const first = enrollment.enroll(learner.id, course.id);
    const second = enrollment.enroll(learner.id, course.id);

    expect(second.id).toBe(first.id);
    expect(db.select().from(schema.enrollments).all()).toHaveLength(1);
  });

  it("an Enrollment in one course does not enroll the learner in another", () => {
    const enrolledCourse = seedCourse("testing-things");
    const otherCourse = seedCourse("other-things");
    const learner = seedLearner();

    enrollment.enroll(learner.id, enrolledCourse.id);

    expect(enrollment.isEnrolled(learner.id, otherCourse.id)).toBe(false);
  });

  it("a learner whose Enrollment has ended is no longer enrolled, but the Enrollment is kept", () => {
    const course = seedCourse("testing-things");
    const learner = seedLearner();
    enrollment.enroll(learner.id, course.id);

    enrollment.endEnrollment(learner.id, course.id);

    expect(enrollment.isEnrolled(learner.id, course.id)).toBe(false);
    expect(enrollment.findEnrollment(learner.id, course.id)).toBeUndefined();
    expect(db.select().from(schema.enrollments).all()).toEqual([
      expect.objectContaining({
        userId: learner.id,
        courseId: course.id,
        endedAt: expect.any(String),
      }),
    ]);
  });
});
