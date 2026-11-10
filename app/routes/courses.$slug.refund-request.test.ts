import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as schema from "~/db/schema";
import { useFreshAppDatabase } from "~/test/setup";

// Acting as a signed-in student: the session reports whichever user id the
// test puts here. null means nobody is signed in.
const session = vi.hoisted(() => ({ userId: null as number | null }));
vi.mock("~/lib/session", () => ({
  getCurrentUserId: vi.fn(async () => session.userId),
}));

// "Today" for every test, unless a test says otherwise. Midday UTC keeps the
// calendar day the same in every timezone the suite is likely to run in.
const TODAY = new Date("2026-03-10T12:00:00.000Z");
const PURCHASED_RECENTLY = "2026-03-01T12:00:00.000Z";

type Db = Awaited<ReturnType<typeof useFreshAppDatabase>>;

let db: Db;
let loggedLines: string[];

beforeEach(async () => {
  db = await useFreshAppDatabase();
  session.userId = null;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TODAY);
  loggedLines = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    loggedLines.push(String(line));
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function seedCourse(price = 4900) {
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
  return db
    .insert(schema.courses)
    .values({
      title: "Testing Things",
      slug: "testing-things",
      description: "A course",
      salesCopy: "## Testing Things",
      instructorId: instructor.id,
      categoryId: category.id,
      status: schema.CourseStatus.Published,
      price,
    })
    .returning()
    .get();
}

function seedUser(name: string, email: string) {
  return db
    .insert(schema.users)
    .values({ name, email, role: schema.UserRole.Student })
    .returning()
    .get();
}

function seedStudent() {
  return seedUser("Lena Learner", "lena@example.com");
}

// A Team Admin buys Seats for a Team and gets no Enrollment from them.
function seedTeamAdmin() {
  return seedUser("Tess Teamlead", "tess@example.com");
}

function seedPurchase(input: {
  userId: number;
  courseId: number;
  amountPaid?: number;
  country?: string | null;
  createdAt?: string;
}) {
  return db
    .insert(schema.purchases)
    .values({
      userId: input.userId,
      courseId: input.courseId,
      amountPaid: input.amountPaid ?? 4900,
      country: input.country ?? "US",
      createdAt: input.createdAt ?? PURCHASED_RECENTLY,
    })
    .returning()
    .get();
}

/** A student, signed in, enrolled, who bought the course recently and watched nothing. */
function seedEligibleStudent(
  purchaseOverrides: Pick<
    Parameters<typeof seedPurchase>[0],
    "amountPaid" | "country" | "createdAt"
  > = {}
) {
  const course = seedCourse();
  const student = seedStudent();
  const purchase = seedPurchase({
    userId: student.id,
    courseId: course.id,
    ...purchaseOverrides,
  });
  db.insert(schema.enrollments)
    .values({ userId: student.id, courseId: course.id })
    .run();
  session.userId = student.id;
  return { course, student, purchase };
}

function storedRefundRequests() {
  return db.select().from(schema.refundRequests).all();
}

async function requestRefund(
  slug = "testing-things",
  reason = "The course was not what I expected."
) {
  const { action } = await import("./courses.$slug.refund-request");
  const body = new FormData();
  body.set("reason", reason);
  const url = new URL(`http://localhost/courses/${slug}/refund-request`);
  const request = new Request(url, { method: "POST", body });
  return action({
    request,
    url,
    pattern: "/courses/:slug/refund-request",
    params: { slug },
    context: new RouterContextProvider(),
  });
}

/** Runs the action, expecting it to throw a `data(...)` refusal. */
async function expectRefusal(promise: Promise<unknown>) {
  const thrown = await promise.then(
    () => {
      throw new Error("Expected the action to refuse, but it succeeded");
    },
    (error: unknown) => error
  );
  if (
    !(typeof thrown === "object" && thrown !== null) ||
    !("data" in thrown) ||
    !("init" in thrown)
  ) {
    throw thrown;
  }
  const init = thrown.init;
  const status =
    typeof init === "object" && init !== null && "status" in init
      ? init.status
      : undefined;
  return { status, message: thrown.data };
}

describe("requesting a refund", () => {
  it("stores an eligible student's request, emails them, and sends them to settings", async () => {
    // Paid less than list (say, with a coupon) at full purchasing power: the
    // refund is the course's list price, not the amount paid.
    const { purchase } = seedEligibleStudent({
      amountPaid: 3900,
      country: "US",
    });

    const response = await requestRefund();

    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) return;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/settings");

    expect(storedRefundRequests()).toEqual([
      expect.objectContaining({
        purchaseId: purchase.id,
        status: "requested",
        reason: "The course was not what I expected.",
      }),
    ]);

    const logged = loggedLines.join("\n");
    expect(logged).toContain("to=lena@example.com");
    expect(logged).toContain("subject=Refund request received: Testing Things");
    expect(logged).toContain("If it is approved, your refund will be $49.00.");
  });

  it("refunds a purchasing-power purchase at the price the student paid", async () => {
    seedEligibleStudent({
      amountPaid: 2450,
      country: "IN",
    });

    await requestRefund();

    expect(loggedLines.join("\n")).toContain(
      "If it is approved, your refund will be $24.50."
    );
  });

  it("refuses a student who is not signed in", async () => {
    seedEligibleStudent();
    session.userId = null;

    expect(await expectRefusal(requestRefund())).toEqual({
      status: 401,
      message: "You must be logged in to request a refund.",
    });
    expect(storedRefundRequests()).toEqual([]);
  });

  it("refuses a course that does not exist", async () => {
    seedEligibleStudent();

    expect(await expectRefusal(requestRefund("no-such-course"))).toEqual({
      status: 404,
      message: "Course not found",
    });
    expect(storedRefundRequests()).toEqual([]);
  });

  it("refuses a student who has not bought the course", async () => {
    seedCourse();
    const student = seedStudent();
    session.userId = student.id;

    expect(await expectRefusal(requestRefund())).toEqual({
      status: 403,
      message: "You have not bought this course.",
    });
    expect(storedRefundRequests()).toEqual([]);
  });

  it("refuses a Team Admin, who has a purchase but no Enrollment", async () => {
    const course = seedCourse();
    const teamAdmin = seedTeamAdmin();
    const purchase = seedPurchase({
      userId: teamAdmin.id,
      courseId: course.id,
    });
    const team = db.insert(schema.teams).values({}).returning().get();
    db.insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: course.id,
        code: "SEAT-1",
        purchaseId: purchase.id,
      })
      .run();
    session.userId = teamAdmin.id;

    expect(await expectRefusal(requestRefund())).toEqual({
      status: 403,
      message: "You are not enrolled in this course.",
    });
    expect(storedRefundRequests()).toEqual([]);
  });

  it("refuses a refunded student, whose Enrollment has ended", async () => {
    const { course, student, purchase } = seedEligibleStudent();
    db.insert(schema.refundRequests)
      .values({
        purchaseId: purchase.id,
        status: schema.RefundRequestStatus.Approved,
        reason: "The course was not what I expected.",
        amountRefunded: 4900,
        resolvedAt: PURCHASED_RECENTLY,
      })
      .run();
    db.update(schema.enrollments)
      .set({ endedAt: PURCHASED_RECENTLY })
      .where(
        and(
          eq(schema.enrollments.userId, student.id),
          eq(schema.enrollments.courseId, course.id)
        )
      )
      .run();

    expect(await expectRefusal(requestRefund())).toEqual({
      status: 403,
      message: "You are not enrolled in this course.",
    });
    expect(storedRefundRequests()).toHaveLength(1);
  });

  it("refuses a purchase with a filled Seat", async () => {
    const { course, student, purchase } = seedEligibleStudent();
    const team = db.insert(schema.teams).values({}).returning().get();
    db.insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: course.id,
        code: "SEAT-1",
        purchaseId: purchase.id,
        redeemedByUserId: student.id,
        redeemedAt: PURCHASED_RECENTLY,
      })
      .run();

    expect(await expectRefusal(requestRefund())).toEqual({
      status: 403,
      message: "A purchase with a filled Seat cannot be refunded.",
    });
    expect(storedRefundRequests()).toEqual([]);
  });

  it("accepts a purchase whose Seats have not been filled yet", async () => {
    const { course, purchase } = seedEligibleStudent();
    const team = db.insert(schema.teams).values({}).returning().get();
    db.insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: course.id,
        code: "SEAT-1",
        purchaseId: purchase.id,
      })
      .run();

    await requestRefund();

    expect(storedRefundRequests()).toHaveLength(1);
  });

  it("accepts a request on the fourteenth day after purchase", async () => {
    seedEligibleStudent({
      createdAt: "2026-02-24T12:00:00.000Z",
    });

    await requestRefund();

    expect(storedRefundRequests()).toHaveLength(1);
  });

  it("refuses once the 14-day window has closed", async () => {
    seedEligibleStudent({
      createdAt: "2026-02-23T12:00:00.000Z",
    });

    expect(await expectRefusal(requestRefund())).toEqual({
      status: 403,
      message: "The 14-day refund window has closed.",
    });
    expect(storedRefundRequests()).toEqual([]);
  });

  it("refuses a student who has watched 2 hours of the course", async () => {
    const { course, student } = seedEligibleStudent();
    const courseModule = db
      .insert(schema.modules)
      .values({ courseId: course.id, title: "Module 1", position: 1 })
      .returning()
      .get();
    const lessonIds = [1, 2].map(
      (position) =>
        db
          .insert(schema.lessons)
          .values({
            moduleId: courseModule.id,
            title: `Lesson ${position}`,
            position,
          })
          .returning()
          .get().id
    );
    // One hour into each of two lessons: two hours in total.
    for (const lessonId of lessonIds) {
      db.insert(schema.videoWatchEvents)
        .values({
          userId: student.id,
          lessonId,
          eventType: "progress",
          positionSeconds: 3600,
        })
        .run();
    }

    expect(await expectRefusal(requestRefund())).toEqual({
      status: 403,
      message: "You have watched too much of this course to get a refund.",
    });
    expect(storedRefundRequests()).toEqual([]);
  });

  it("refuses a student who has completed half the lessons", async () => {
    const { course, student } = seedEligibleStudent();
    const courseModule = db
      .insert(schema.modules)
      .values({ courseId: course.id, title: "Module 1", position: 1 })
      .returning()
      .get();
    const [firstLesson] = [1, 2].map((position) =>
      db
        .insert(schema.lessons)
        .values({
          moduleId: courseModule.id,
          title: `Lesson ${position}`,
          position,
        })
        .returning()
        .get()
    );
    db.insert(schema.lessonProgress)
      .values({
        userId: student.id,
        lessonId: firstLesson.id,
        status: schema.LessonProgressStatus.Completed,
        completedAt: PURCHASED_RECENTLY,
      })
      .run();

    expect(await expectRefusal(requestRefund())).toEqual({
      status: 403,
      message: "You have completed too much of this course to get a refund.",
    });
    expect(storedRefundRequests()).toEqual([]);
  });

  it("refuses on a date before the purchase day", async () => {
    seedEligibleStudent({ createdAt: "2026-03-11T12:00:00.000Z" });

    expect(await expectRefusal(requestRefund())).toEqual({
      status: 403,
      message: "The 14-day refund window has closed.",
    });
    expect(storedRefundRequests()).toEqual([]);
  });

  it("refuses a second request while one is open, storing nothing more", async () => {
    seedEligibleStudent();
    await requestRefund();

    expect(await expectRefusal(requestRefund())).toEqual({
      status: 409,
      message: "You already have a request open on this purchase.",
    });
    expect(storedRefundRequests()).toHaveLength(1);
  });

  it("refuses a second request once the first was declined, because the decision is final", async () => {
    const { purchase } = seedEligibleStudent();
    db.insert(schema.refundRequests)
      .values({
        purchaseId: purchase.id,
        status: schema.RefundRequestStatus.Declined,
        reason: "The course was not what I expected.",
        resolvedAt: PURCHASED_RECENTLY,
      })
      .run();

    expect(await expectRefusal(requestRefund())).toEqual({
      status: 409,
      message:
        "This purchase already had a Refund Request, and that decision is final.",
    });
    expect(storedRefundRequests()).toHaveLength(1);
  });

  it("refuses a new purchase once the student has had 3 Refunds for the course", async () => {
    const { course, student } = seedEligibleStudent({
      createdAt: "2026-03-08T12:00:00.000Z",
    });
    seedEarlierRefundRequests(student.id, course.id, [
      schema.RefundRequestStatus.Approved,
      schema.RefundRequestStatus.Approved,
      schema.RefundRequestStatus.Approved,
    ]);

    expect(await expectRefusal(requestRefund())).toEqual({
      status: 403,
      message:
        "You have already had 3 Refunds for this course, so this purchase can't be refunded.",
    });
    expect(storedRefundRequests()).toHaveLength(3);
  });

  it("accepts a new purchase after 2 Refunds and a declined request for the course", async () => {
    const { course, student } = seedEligibleStudent({
      createdAt: "2026-03-08T12:00:00.000Z",
    });
    seedEarlierRefundRequests(student.id, course.id, [
      schema.RefundRequestStatus.Approved,
      schema.RefundRequestStatus.Approved,
      schema.RefundRequestStatus.Declined,
    ]);

    await requestRefund();

    expect(storedRefundRequests()).toHaveLength(4);
  });

  it("does not count Refunds for other courses toward the limit", async () => {
    const { student } = seedEligibleStudent({
      createdAt: "2026-03-08T12:00:00.000Z",
    });
    const otherCourse = seedOtherCourse();
    seedEarlierRefundRequests(student.id, otherCourse.id, [
      schema.RefundRequestStatus.Approved,
      schema.RefundRequestStatus.Approved,
      schema.RefundRequestStatus.Approved,
    ]);

    await requestRefund();

    expect(storedRefundRequests()).toHaveLength(4);
  });

  it("refuses a reason that is too short, storing nothing", async () => {
    seedEligibleStudent();

    const response = await requestRefund("testing-things", "meh");

    expect(response).toEqual(
      expect.objectContaining({
        data: {
          errors: {
            reason: "Tell us a little more about why you want a refund.",
          },
        },
        init: { status: 400 },
      })
    );
    expect(storedRefundRequests()).toEqual([]);
  });
});

/**
 * Earlier purchases of the course by the student, each with a resolved Refund
 * Request of the given status. Bought before the student's latest purchase.
 */
function seedEarlierRefundRequests(
  userId: number,
  courseId: number,
  statuses: schema.RefundRequestStatus[]
) {
  statuses.forEach((status, index) => {
    const purchase = seedPurchase({
      userId,
      courseId,
      createdAt: `2026-01-0${index + 1}T12:00:00.000Z`,
    });
    db.insert(schema.refundRequests)
      .values({
        purchaseId: purchase.id,
        status,
        reason: "The course was not what I expected.",
        amountRefunded:
          status === schema.RefundRequestStatus.Approved ? 4900 : null,
        resolvedAt: `2026-01-0${index + 2}T12:00:00.000Z`,
      })
      .run();
  });
}

function seedOtherCourse() {
  const course = db
    .select()
    .from(schema.courses)
    .where(eq(schema.courses.slug, "testing-things"))
    .get();
  if (!course) throw new Error("seedEligibleStudent adds testing-things");
  return db
    .insert(schema.courses)
    .values({
      title: "Other Things",
      slug: "other-things",
      description: "Another course",
      salesCopy: "## Other Things",
      instructorId: course.instructorId,
      categoryId: course.categoryId,
      status: schema.CourseStatus.Published,
      price: 4900,
    })
    .returning()
    .get();
}
