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

function seedStudent() {
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
  it("a student who never enrolled is not enrolled", () => {
    const course = seedCourse("testing-things");
    const student = seedStudent();

    expect(enrollment.isEnrolled(student.id, course.id)).toBe(false);
    expect(enrollment.findEnrollment(student.id, course.id)).toBeUndefined();
  });

  it("enrolling makes the student enrolled in that course", () => {
    const course = seedCourse("testing-things");
    const student = seedStudent();

    const enrolled = enrollment.enroll(student.id, course.id);

    expect(enrollment.isEnrolled(student.id, course.id)).toBe(true);
    expect(enrollment.findEnrollment(student.id, course.id)).toEqual(enrolled);
    expect(enrolled).toMatchObject({ userId: student.id, courseId: course.id });
  });

  it("enrolling twice leaves the student with one Enrollment", () => {
    const course = seedCourse("testing-things");
    const student = seedStudent();

    const first = enrollment.enroll(student.id, course.id);
    const second = enrollment.enroll(student.id, course.id);

    expect(second.id).toBe(first.id);
    expect(db.select().from(schema.enrollments).all()).toHaveLength(1);
  });

  it("an Enrollment in one course does not enroll the student in another", () => {
    const enrolledCourse = seedCourse("testing-things");
    const otherCourse = seedCourse("other-things");
    const student = seedStudent();

    enrollment.enroll(student.id, enrolledCourse.id);

    expect(enrollment.isEnrolled(student.id, otherCourse.id)).toBe(false);
  });

  it("a student whose Enrollment has ended is no longer enrolled, but the Enrollment is kept", () => {
    const course = seedCourse("testing-things");
    const student = seedStudent();
    enrollment.enroll(student.id, course.id);

    enrollment.endEnrollment(student.id, course.id);

    expect(enrollment.isEnrolled(student.id, course.id)).toBe(false);
    expect(enrollment.findEnrollment(student.id, course.id)).toBeUndefined();
    expect(db.select().from(schema.enrollments).all()).toEqual([
      expect.objectContaining({
        userId: student.id,
        courseId: course.id,
        endedAt: expect.any(String),
      }),
    ]);
  });
});
