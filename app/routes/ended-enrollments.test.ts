import { RouterContextProvider } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as schema from "~/db/schema";
import { useFreshAppDatabase } from "~/test/setup";

// A Cancellation ends an Enrollment without deleting it (ADR 0001). These
// tests check that every enrollment list and count leaves the learner out.

// Acting as a signed-in user: the session reports whichever user id the test
// puts here. null means nobody is signed in.
const session = vi.hoisted(() => ({ userId: null as number | null }));
vi.mock("~/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/session")>()),
  getCurrentUserId: vi.fn(async () => session.userId),
  getDevCountry: vi.fn(async () => null),
}));

type Db = Awaited<ReturnType<typeof useFreshAppDatabase>>;

let db: Db;
type User = typeof schema.users.$inferSelect;
type Course = typeof schema.courses.$inferSelect;

let instructor: User;
let course: Course;
let stayingLearner: User;
let refundedLearner: User;

beforeEach(async () => {
  db = await useFreshAppDatabase();
  instructor = seedUser("Ida Instructor", schema.UserRole.Instructor);
  course = seedCourse("Testing Things");
  stayingLearner = seedUser("Sam Stays", schema.UserRole.Student);
  refundedLearner = seedUser("Rita Refunded", schema.UserRole.Student);
  seedEnrollment(stayingLearner.id, course.id);
  seedEnrollment(refundedLearner.id, course.id, "2026-11-01T12:00:00.000Z");
  session.userId = null;
});

function seedUser(name: string, role: schema.UserRole) {
  const email = `${name.split(" ")[0].toLowerCase()}@example.com`;
  return db
    .insert(schema.users)
    .values({ name, email, role })
    .returning()
    .get();
}

function seedCourse(title: string) {
  const category = db
    .insert(schema.categories)
    .values({ name: "Programming", slug: "programming" })
    .returning()
    .get();
  const course = db
    .insert(schema.courses)
    .values({
      title,
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      description: "A course",
      salesCopy: `## ${title}`,
      instructorId: instructor.id,
      categoryId: category.id,
      status: schema.CourseStatus.Published,
      price: 4900,
    })
    .returning()
    .get();
  const module = db
    .insert(schema.modules)
    .values({ courseId: course.id, title: "Module 1", position: 1 })
    .returning()
    .get();
  db.insert(schema.lessons)
    .values({ moduleId: module.id, title: "Lesson 1", position: 0 })
    .run();
  return course;
}

function seedEnrollment(userId: number, courseId: number, endedAt?: string) {
  db.insert(schema.enrollments).values({ userId, courseId, endedAt }).run();
}

function seedPurchase(userId: number, courseId: number) {
  db.insert(schema.purchases)
    .values({ userId, courseId, amountPaid: course.price, country: "US" })
    .run();
}

function signInAs(user: User) {
  session.userId = user.id;
}

function signInAsAdmin() {
  signInAs(seedUser("Luis Admin", schema.UserRole.Admin));
}

function loaderArgs<Params extends Record<string, string>>(
  path: string,
  params: Params = {} as Params
) {
  const url = new URL(`http://localhost${path}`);
  return {
    request: new Request(url),
    url,
    pattern: path,
    params,
    context: new RouterContextProvider(),
  };
}

// Guards ADR 0001: every enrollment list and count ignores ended Enrollments.
describe("a learner with an ended Enrollment", () => {
  it("no longer sees the course on their dashboard", async () => {
    const { loader } = await import("./dashboard");
    signInAs(refundedLearner);

    const page = await loader(loaderArgs("/dashboard"));

    expect(page.inProgressCourses).toEqual([]);
    expect(page.completedCourses).toEqual([]);
  });

  it("sees the course as not enrolled on the course list", async () => {
    const { loader } = await import("./courses");
    signInAs(refundedLearner);

    const page = await loader(loaderArgs("/courses"));

    const listed = page.courses.find((c) => c.id === course.id);
    expect(listed?.progress).toBeNull();
    expect(listed?.completedLessons).toBeNull();
  });

  it("leaves a learner with an active Enrollment enrolled on the course list", async () => {
    const { loader } = await import("./courses");
    signInAs(stayingLearner);

    const page = await loader(loaderArgs("/courses"));

    const listed = page.courses.find((c) => c.id === course.id);
    expect(listed?.progress).toBe(0);
  });
});

describe("an instructor", () => {
  it("doesn't count an ended Enrollment on their courses list", async () => {
    const { loader } = await import("./instructor");
    signInAs(instructor);

    const page = await loader(loaderArgs("/instructor"));

    expect(page.courses.map((c) => c.enrollmentCount)).toEqual([1]);
  });

  it("doesn't count or list an ended Enrollment on the course page", async () => {
    const { loader } = await import("./instructor.$courseId");
    signInAs(instructor);

    const page = await loader(
      loaderArgs(`/instructor/${course.id}`, { courseId: String(course.id) })
    );

    expect(page.enrollmentCount).toBe(1);
    expect(page.students.map((s) => s.name)).toEqual(["Sam Stays"]);
  });

  it("doesn't list an ended Enrollment among the course's students", async () => {
    const { loader } = await import("./instructor.$courseId.students");
    signInAs(instructor);

    const page = await loader(
      loaderArgs(`/instructor/${course.id}/students`, {
        courseId: String(course.id),
      })
    );

    expect(page.students.map((s) => s.name)).toEqual(["Sam Stays"]);
  });

  it("doesn't count an ended Enrollment, or its progress, in course analytics", async () => {
    const { loader } = await import("./instructor.analytics");
    signInAs(instructor);
    const lesson = db.select().from(schema.lessons).get();
    if (!lesson) throw new Error("seedCourse adds a lesson");
    db.insert(schema.lessonProgress)
      .values({
        userId: refundedLearner.id,
        lessonId: lesson.id,
        status: schema.LessonProgressStatus.Completed,
        completedAt: "2026-10-30T12:00:00.000Z",
      })
      .run();

    const page = await loader(
      loaderArgs(`/instructor/analytics?tab=course&course=${course.id}`)
    );

    expect(page.progress).toMatchObject({
      enrolledCount: 1,
      averageProgressPercent: 0,
      finishedCount: 0,
    });
    expect(page.funnel?.enrolledCount).toBe(1);
    expect(page.funnel?.modules.map((m) => m.reachedCount)).toEqual([0]);
  });

  it("doesn't count an ended Enrollment among enrolled students in analytics", async () => {
    const { loader } = await import("./instructor.analytics");
    signInAs(instructor);

    const page = await loader(loaderArgs("/instructor/analytics?range=all"));

    expect(page.audience.studentCount).toBe(1);
  });

  it("doesn't show a refunded top buyer as enrolled in analytics", async () => {
    const { loader } = await import("./instructor.analytics");
    signInAs(instructor);
    seedPurchase(stayingLearner.id, course.id);
    seedPurchase(refundedLearner.id, course.id);

    const page = await loader(loaderArgs("/instructor/analytics?range=all"));

    const enrolledByName = Object.fromEntries(
      page.buyers.map((buyer) => [buyer.name, buyer.enrolled])
    );
    expect(enrolledByName).toEqual({
      "Sam Stays": true,
      "Rita Refunded": false,
    });
  });
});

describe("an Admin", () => {
  it("doesn't count an ended Enrollment on the admin courses page", async () => {
    const { loader } = await import("./admin.courses");
    signInAsAdmin();

    const page = await loader(loaderArgs("/admin/courses"));

    expect(page.courses.map((c) => c.enrollmentCount)).toEqual([1]);
  });
});

describe("the purchase page", () => {
  it("doesn't count an ended Enrollment among the course's students", async () => {
    const { loader } = await import("./courses.$slug.purchase");
    signInAs(seedUser("Bea Buyer", schema.UserRole.Student));

    const page = await loader(
      loaderArgs(`/courses/${course.slug}/purchase`, { slug: course.slug })
    );

    expect(page.enrollmentCount).toBe(1);
  });
});
