import { RouterContextProvider } from "react-router";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as schema from "~/db/schema";
import { useFreshAppDatabase } from "~/test/setup";

// Buying again after a Cancellation reopens the student's existing Enrollment
// (ADR 0001): there is never a second Enrollment, and all learning state comes
// back as it was.

// Acting as a signed-in student: the session reports whichever user id the
// test puts here. The session holds no dev country override.
const session = vi.hoisted(() => ({ userId: null as number | null }));
vi.mock("~/lib/session", () => ({
  getCurrentUserId: vi.fn(async () => session.userId),
  getSession: vi.fn(async () => ({ get: () => undefined })),
}));

const ENROLLED_AT = "2026-01-05T12:00:00.000Z";
const COMPLETED_AT = "2026-02-01T12:00:00.000Z";
const TODAY = new Date("2026-03-10T12:00:00.000Z");

type Db = Awaited<ReturnType<typeof useFreshAppDatabase>>;

let db: Db;

beforeEach(async () => {
  db = await useFreshAppDatabase();
  session.userId = null;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TODAY);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * A student who bought and completed the course, watched part of its video
 * lesson and passed its quiz, then had a Cancellation (an approved Refund).
 */
async function seedRefundedStudent() {
  const instructor = db
    .insert(schema.users)
    .values({
      name: "Ada Instructor",
      email: "ada@example.com",
      role: schema.UserRole.Instructor,
    })
    .returning()
    .get();
  const category = db
    .insert(schema.categories)
    .values({ name: "Programming", slug: "programming" })
    .returning()
    .get();
  const course = db
    .insert(schema.courses)
    .values({
      title: "Testing Things",
      slug: "testing-things",
      description: "A course",
      salesCopy: "## Testing Things",
      instructorId: instructor.id,
      categoryId: category.id,
      status: schema.CourseStatus.Published,
      price: 4900,
      pppEnabled: false,
    })
    .returning()
    .get();
  const mod = db
    .insert(schema.modules)
    .values({ courseId: course.id, title: "Basics", position: 1 })
    .returning()
    .get();
  const lesson = db
    .insert(schema.lessons)
    .values({
      moduleId: mod.id,
      title: "First steps",
      videoUrl: "https://example.com/video.mp4",
      durationMinutes: 10,
      position: 1,
    })
    .returning()
    .get();
  const quiz = db
    .insert(schema.quizzes)
    .values({ lessonId: lesson.id, title: "Check", passingScore: 0.7 })
    .returning()
    .get();

  const student = db
    .insert(schema.users)
    .values({
      name: "Lena Learner",
      email: "lena@example.com",
      role: schema.UserRole.Student,
    })
    .returning()
    .get();
  db.insert(schema.purchases)
    .values({
      userId: student.id,
      courseId: course.id,
      amountPaid: 4900,
      country: "US",
      createdAt: ENROLLED_AT,
    })
    .run();
  const enrollment = db
    .insert(schema.enrollments)
    .values({
      userId: student.id,
      courseId: course.id,
      enrolledAt: ENROLLED_AT,
      completedAt: COMPLETED_AT,
    })
    .returning()
    .get();
  db.insert(schema.lessonProgress)
    .values({
      userId: student.id,
      lessonId: lesson.id,
      status: schema.LessonProgressStatus.Completed,
      completedAt: COMPLETED_AT,
    })
    .run();
  db.insert(schema.videoWatchEvents)
    .values({
      userId: student.id,
      lessonId: lesson.id,
      eventType: "pause",
      positionSeconds: 245,
    })
    .run();
  db.insert(schema.quizAttempts)
    .values({ userId: student.id, quizId: quiz.id, score: 0.9, passed: true })
    .run();

  const { endEnrollment } = await import("~/lib/enrollment.server");
  endEnrollment(student.id, course.id);

  session.userId = student.id;
  return { course, mod, lesson, student, enrollment };
}

/** Runs a route action and returns the redirect or error Response it ends with. */
async function settle(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (thrown) {
    return thrown;
  }
}

async function buyAgain(slug = "testing-things") {
  const { action } = await import("./courses.$slug.purchase");
  const body = new FormData();
  body.set("intent", "confirm-purchase");
  const url = new URL(`http://localhost/courses/${slug}/purchase`);
  return settle(() =>
    action({
      request: new Request(url, { method: "POST", body }),
      url,
      pattern: "/courses/:slug/purchase",
      params: { slug },
      context: new RouterContextProvider(),
    })
  );
}

function enrollmentsOf(userId: number) {
  return db
    .select()
    .from(schema.enrollments)
    .all()
    .filter((e) => e.userId === userId);
}

// Guards ADR 0001: buying again reopens the Enrollment and restores learning state.
describe("Buying again after a Cancellation", () => {
  it("reopens the same Enrollment instead of creating a second one", async () => {
    const { student, enrollment } = await seedRefundedStudent();

    const response = await buyAgain();

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).headers.get("Location")).toBe(
      "/courses/testing-things/welcome"
    );
    const rows = enrollmentsOf(student.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: enrollment.id,
      enrolledAt: ENROLLED_AT,
      completedAt: COMPLETED_AT,
      endedAt: null,
    });
  });
});

/** A team buyer's unredeemed coupon for the course. */
function seedCoupon(courseId: number, code = "TEAM-SEAT-1") {
  const buyer = db
    .insert(schema.users)
    .values({
      name: "Tess Teamlead",
      email: "tess@example.com",
      role: schema.UserRole.Student,
    })
    .returning()
    .get();
  const purchase = db
    .insert(schema.purchases)
    .values({ userId: buyer.id, courseId, amountPaid: 9800, country: null })
    .returning()
    .get();
  const team = db.insert(schema.teams).values({}).returning().get();
  db.insert(schema.coupons)
    .values({ teamId: team.id, courseId, code, purchaseId: purchase.id })
    .run();
  return code;
}

async function redeem(code: string) {
  const { action } = await import("./redeem.$code");
  const body = new FormData();
  body.set("intent", "confirm-redeem");
  const url = new URL(`http://localhost/redeem/${code}`);
  return settle(() =>
    action({
      request: new Request(url, { method: "POST", body }),
      url,
      pattern: "/redeem/:code",
      params: { code },
      context: new RouterContextProvider(),
    })
  );
}

describe("Redeeming a coupon after a Cancellation", () => {
  it("reopens the same Enrollment instead of creating a second one", async () => {
    const { course, student, enrollment } = await seedRefundedStudent();
    const code = seedCoupon(course.id);

    const response = await redeem(code);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).headers.get("Location")).toBe(
      "/courses/testing-things/welcome"
    );
    const rows = enrollmentsOf(student.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: enrollment.id,
      enrolledAt: ENROLLED_AT,
      completedAt: COMPLETED_AT,
      endedAt: null,
    });
  });
});

async function viewLesson(slug: string, lessonId: number) {
  const { loader } = await import("./courses.$slug.lessons.$lessonId");
  const url = new URL(`http://localhost/courses/${slug}/lessons/${lessonId}`);
  return loader({
    request: new Request(url),
    url,
    pattern: "/courses/:slug/lessons/:lessonId",
    params: { slug, lessonId: String(lessonId) },
    context: new RouterContextProvider(),
  });
}

async function viewDashboard() {
  const { loader } = await import("./dashboard");
  const url = new URL("http://localhost/dashboard");
  return loader({
    request: new Request(url),
    url,
    pattern: "/dashboard",
    params: {},
    context: new RouterContextProvider(),
  });
}

describe("Learning state after buying again", () => {
  it("shows the earlier lesson progress, video position and quiz result", async () => {
    const { lesson } = await seedRefundedStudent();

    await buyAgain();
    const page = await viewLesson("testing-things", lesson.id);

    expect(page.enrolled).toBe(true);
    expect(page.lessonStatus).toBe(schema.LessonProgressStatus.Completed);
    expect(page.lastWatchPosition).toBe(245);
    expect(page.bestAttempt).toEqual({ score: 0.9, passed: true });
  });

  it("shows the course as completed on the date it was first completed", async () => {
    await seedRefundedStudent();

    await buyAgain();
    const dashboard = await viewDashboard();

    expect(dashboard.inProgressCourses).toEqual([]);
    expect(dashboard.completedCourses).toHaveLength(1);
    expect(dashboard.completedCourses[0]).toMatchObject({
      courseSlug: "testing-things",
      completedAt: COMPLETED_AT,
    });
  });
});
