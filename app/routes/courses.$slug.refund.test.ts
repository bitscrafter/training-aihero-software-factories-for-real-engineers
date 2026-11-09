import { RouterContextProvider } from "react-router";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as schema from "~/db/schema";
import { useFreshAppDatabase } from "~/test/setup";

// Acting as a signed-in learner: the session reports whichever user id the
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

/** A learner, signed in, who bought the course recently and watched nothing. */
function seedEligibleLearner() {
  const course = seedCourse();
  const learner = seedLearner();
  const purchase = seedPurchase({ userId: learner.id, courseId: course.id });
  session.userId = learner.id;
  return { course, learner, purchase };
}

function storedRefunds() {
  return db.select().from(schema.refunds).all();
}

async function requestRefund(
  slug = "testing-things",
  reason = "The course was not what I expected."
) {
  const { action } = await import("./courses.$slug.refund");
  const body = new FormData();
  body.set("reason", reason);
  const url = new URL(`http://localhost/courses/${slug}/refund`);
  const request = new Request(url, { method: "POST", body });
  return action({
    request,
    url,
    pattern: "/courses/:slug/refund",
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
  it("stores an eligible learner's request, emails them, and sends them to settings", async () => {
    const { purchase } = seedEligibleLearner();

    const response = await requestRefund();

    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) return;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/settings");

    expect(storedRefunds()).toEqual([
      expect.objectContaining({
        purchaseId: purchase.id,
        status: "requested",
        reason: "The course was not what I expected.",
      }),
    ]);

    const logged = loggedLines.join("\n");
    expect(logged).toContain("to=lena@example.com");
    expect(logged).toContain(
      "The Reversal is for $49.00, the amount you paid."
    );
  });

  it("refunds a purchasing-power purchase at the price the learner paid", async () => {
    const course = seedCourse(4900);
    const learner = seedLearner();
    seedPurchase({
      userId: learner.id,
      courseId: course.id,
      amountPaid: 2450,
      country: "IN",
    });
    session.userId = learner.id;

    await requestRefund();

    expect(loggedLines.join("\n")).toContain(
      "The Reversal is for $24.50, the amount you paid."
    );
  });

  it("refuses a learner who is not signed in", async () => {
    seedEligibleLearner();
    session.userId = null;

    expect(await expectRefusal(requestRefund())).toEqual({
      status: 401,
      message: "You must be logged in to cancel a purchase.",
    });
    expect(storedRefunds()).toEqual([]);
  });

  it("refuses a course that does not exist", async () => {
    seedEligibleLearner();

    expect(await expectRefusal(requestRefund("no-such-course"))).toEqual({
      status: 404,
      message: "Course not found",
    });
    expect(storedRefunds()).toEqual([]);
  });

  it("refuses a learner who has not bought the course", async () => {
    seedCourse();
    const learner = seedLearner();
    session.userId = learner.id;

    expect(await expectRefusal(requestRefund())).toEqual({
      status: 403,
      message: "You have not bought this course.",
    });
    expect(storedRefunds()).toEqual([]);
  });

  it("refuses a claimed team seat", async () => {
    const { course, learner, purchase } = seedEligibleLearner();
    const team = db.insert(schema.teams).values({}).returning().get();
    db.insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: course.id,
        code: "SEAT-1",
        purchaseId: purchase.id,
        redeemedByUserId: learner.id,
        redeemedAt: PURCHASED_RECENTLY,
      })
      .run();

    expect(await expectRefusal(requestRefund())).toEqual({
      status: 403,
      message: "A claimed team seat cannot be cancelled.",
    });
    expect(storedRefunds()).toEqual([]);
  });

  it("accepts a purchase whose team seat has not been claimed yet", async () => {
    const { course, purchase } = seedEligibleLearner();
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

    expect(storedRefunds()).toHaveLength(1);
  });

  it("accepts a request on the fourteenth day after purchase", async () => {
    const course = seedCourse();
    const learner = seedLearner();
    seedPurchase({
      userId: learner.id,
      courseId: course.id,
      createdAt: "2026-02-24T12:00:00.000Z",
    });
    session.userId = learner.id;

    await requestRefund();

    expect(storedRefunds()).toHaveLength(1);
  });

  it("refuses once the 14-day window has closed", async () => {
    const course = seedCourse();
    const learner = seedLearner();
    seedPurchase({
      userId: learner.id,
      courseId: course.id,
      createdAt: "2026-02-23T12:00:00.000Z",
    });
    session.userId = learner.id;

    expect(await expectRefusal(requestRefund())).toEqual({
      status: 403,
      message: "The 14-day window has closed.",
    });
    expect(storedRefunds()).toEqual([]);
  });

  it("refuses a learner who has watched 2 hours of the course", async () => {
    const { course, learner } = seedEligibleLearner();
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
          userId: learner.id,
          lessonId,
          eventType: "progress",
          positionSeconds: 3600,
        })
        .run();
    }

    expect(await expectRefusal(requestRefund())).toEqual({
      status: 403,
      message: "You have watched too much of this course to cancel it.",
    });
    expect(storedRefunds()).toEqual([]);
  });

  it("refuses a second request while one is open, storing nothing more", async () => {
    seedEligibleLearner();
    await requestRefund();

    expect(await expectRefusal(requestRefund())).toEqual({
      status: 409,
      message: "You already have a request open on this purchase.",
    });
    expect(storedRefunds()).toHaveLength(1);
  });

  it("refuses a reason that is too short, storing nothing", async () => {
    seedEligibleLearner();

    const response = await requestRefund("testing-things", "meh");

    expect(response).toEqual(
      expect.objectContaining({
        data: {
          errors: {
            reason: "Tell us a little more about why you want to cancel.",
          },
        },
        init: { status: 400 },
      })
    );
    expect(storedRefunds()).toEqual([]);
  });
});
