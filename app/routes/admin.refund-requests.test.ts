import { RouterContextProvider } from "react-router";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as schema from "~/db/schema";
import { useFreshAppDatabase } from "~/test/setup";

// Acting as a signed-in user: the session reports whichever user id the test
// puts here. null means nobody is signed in.
const session = vi.hoisted(() => ({ userId: null as number | null }));
vi.mock("~/lib/session", () => ({
  getCurrentUserId: vi.fn(async () => session.userId),
  getDevCountry: vi.fn(async () => null),
}));

const TODAY = new Date("2026-11-09T12:00:00.000Z");

type Db = Awaited<ReturnType<typeof useFreshAppDatabase>>;

let db: Db;

beforeEach(async () => {
  db = await useFreshAppDatabase();
  session.userId = null;
  categoryId = undefined;
  instructorId = undefined;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TODAY);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function seedUser(name: string, role: schema.UserRole) {
  const email = `${name.split(" ")[0].toLowerCase()}@example.com`;
  return db
    .insert(schema.users)
    .values({ name, email, role })
    .returning()
    .get();
}

let categoryId: number | undefined;
let instructorId: number | undefined;

function seedCourse(title: string, price: number, lessonCount = 0) {
  instructorId ??= seedUser("Ida Instructor", schema.UserRole.Instructor).id;
  categoryId ??= db
    .insert(schema.categories)
    .values({ name: "Programming", slug: "programming" })
    .returning()
    .get().id;
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const course = db
    .insert(schema.courses)
    .values({
      title,
      slug,
      description: "A course",
      salesCopy: `## ${title}`,
      instructorId,
      categoryId,
      status: schema.CourseStatus.Published,
      price,
    })
    .returning()
    .get();
  const module = db
    .insert(schema.modules)
    .values({ courseId: course.id, title: "Module 1", position: 1 })
    .returning()
    .get();
  const lessonIds = Array.from(
    { length: lessonCount },
    (_, i) =>
      db
        .insert(schema.lessons)
        .values({ moduleId: module.id, title: `Lesson ${i + 1}`, position: i })
        .returning()
        .get().id
  );
  return { course, lessonIds };
}

function seedPurchase(input: {
  userId: number;
  courseId: number;
  amountPaid: number;
  country?: string;
  createdAt: string;
}) {
  return db
    .insert(schema.purchases)
    .values({ country: "US", ...input })
    .returning()
    .get();
}

function seedRefundRequest(input: {
  purchaseId: number;
  reason?: string;
  requestedAt: string;
  status?: schema.RefundRequestStatus;
  amountRefunded?: number;
  resolvedAt?: string;
  resolvedByUserId?: number;
}) {
  return db
    .insert(schema.refundRequests)
    .values({ reason: "Not what I expected.", ...input })
    .returning()
    .get();
}

function signInAsAdmin() {
  const admin = seedUser("Luis Admin", schema.UserRole.Admin);
  session.userId = admin.id;
  return admin;
}

async function loadRefundRequests() {
  const { loader } = await import("./admin.refund-requests");
  const url = new URL("http://localhost/admin/refund-requests");
  return loader({
    request: new Request(url),
    url,
    pattern: "/admin/refund-requests",
    params: {},
    context: new RouterContextProvider(),
  });
}

/** Runs the loader, expecting it to throw a `data(...)` refusal. */
async function expectRefusal(promise: Promise<unknown>) {
  const thrown = await promise.then(
    () => {
      throw new Error("Expected the loader to refuse, but it succeeded");
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
  return typeof init === "object" && init !== null && "status" in init
    ? init.status
    : undefined;
}

describe("the Admin Refund Requests screen", () => {
  it("lists open Refund Requests oldest first, with the facts to decide on", async () => {
    signInAsAdmin();
    const ana = seedUser("Ana Souza", schema.UserRole.Student);
    const ben = seedUser("Ben Ito", schema.UserRole.Student);
    const { course: typescript, lessonIds } = seedCourse(
      "Advanced TypeScript",
      4900,
      20
    );
    const { course: sql } = seedCourse("Intro to SQL", 2900);

    // Ana paid less than list at full purchasing power, so her Refund is the
    // list price; she has watched some of the course and completed 3 lessons.
    const anaPurchase = seedPurchase({
      userId: ana.id,
      courseId: typescript.id,
      amountPaid: 3900,
      createdAt: "2026-10-30T09:00:00.000Z",
    });
    db.insert(schema.videoWatchEvents)
      .values([
        { userId: ana.id, lessonId: lessonIds[0], eventType: "progress", positionSeconds: 600 },
        { userId: ana.id, lessonId: lessonIds[0], eventType: "progress", positionSeconds: 1200 },
        { userId: ana.id, lessonId: lessonIds[1], eventType: "progress", positionSeconds: 1320 },
      ])
      .run();
    db.insert(schema.lessonProgress)
      .values(
        lessonIds.slice(0, 3).map((lessonId) => ({
          userId: ana.id,
          lessonId,
          status: schema.LessonProgressStatus.Completed,
        }))
      )
      .run();

    // Ben bought at a purchasing-power price, so his Refund is what he paid.
    const benPurchase = seedPurchase({
      userId: ben.id,
      courseId: sql.id,
      amountPaid: 1450,
      country: "IN",
      createdAt: "2026-11-01T09:00:00.000Z",
    });

    // Ben asked more recently than Ana, but is seeded first.
    seedRefundRequest({
      purchaseId: benPurchase.id,
      requestedAt: "2026-11-07T10:00:00.000Z",
    });
    seedRefundRequest({
      purchaseId: anaPurchase.id,
      reason: "The course assumes React experience I don't have yet.",
      requestedAt: "2026-11-05T10:00:00.000Z",
    });

    const { open } = await loadRefundRequests();

    expect(open).toEqual([
      expect.objectContaining({
        learner: { name: "Ana Souza", email: "ana@example.com" },
        courseTitle: "Advanced TypeScript",
        requestedAt: "2026-11-05T10:00:00.000Z",
        purchasedAt: "2026-10-30T09:00:00.000Z",
        amountPaid: 3900,
        refundAmount: 4900,
        secondsWatched: 2520,
        lessonsCompleted: 3,
        totalLessons: 20,
        reason: "The course assumes React experience I don't have yet.",
      }),
      expect.objectContaining({
        learner: { name: "Ben Ito", email: "ben@example.com" },
        courseTitle: "Intro to SQL",
        amountPaid: 1450,
        refundAmount: 1450,
        secondsWatched: 0,
        lessonsCompleted: 0,
        totalLessons: 0,
      }),
    ]);
  });
});

describe("resolved Refund Requests on the Admin screen", () => {
  it("lists approved and declined requests with who resolved them and when", async () => {
    const admin = signInAsAdmin();
    const ben = seedUser("Ben Ito", schema.UserRole.Student);
    const cy = seedUser("Cy Ruiz", schema.UserRole.Student);
    const { course: sql } = seedCourse("Intro to SQL", 2900);
    const { course: node } = seedCourse("Node in Depth", 3900);

    seedRefundRequest({
      purchaseId: seedPurchase({
        userId: cy.id,
        courseId: node.id,
        amountPaid: 3900,
        createdAt: "2026-10-20T09:00:00.000Z",
      }).id,
      requestedAt: "2026-10-25T09:00:00.000Z",
      status: schema.RefundRequestStatus.Declined,
      resolvedAt: "2026-11-01T09:00:00.000Z",
      resolvedByUserId: admin.id,
    });
    seedRefundRequest({
      purchaseId: seedPurchase({
        userId: ben.id,
        courseId: sql.id,
        amountPaid: 2900,
        createdAt: "2026-10-28T09:00:00.000Z",
      }).id,
      requestedAt: "2026-10-30T09:00:00.000Z",
      status: schema.RefundRequestStatus.Approved,
      amountRefunded: 2900,
      resolvedAt: "2026-11-02T09:00:00.000Z",
      resolvedByUserId: admin.id,
    });

    const { open, resolved } = await loadRefundRequests();

    expect(open).toEqual([]);
    expect(resolved).toEqual([
      expect.objectContaining({
        status: "approved",
        learner: { name: "Ben Ito" },
        courseTitle: "Intro to SQL",
        refundAmount: 2900,
        resolvedBy: { name: "Luis Admin" },
        resolvedAt: "2026-11-02T09:00:00.000Z",
      }),
      expect.objectContaining({
        status: "declined",
        learner: { name: "Cy Ruiz" },
        courseTitle: "Node in Depth",
        refundAmount: null,
        resolvedBy: { name: "Luis Admin" },
        resolvedAt: "2026-11-01T09:00:00.000Z",
      }),
    ]);
  });
});

describe("who can see the Admin Refund Requests screen", () => {
  it.each([schema.UserRole.Student, schema.UserRole.Instructor])(
    "refuses a %s with 403",
    async (role) => {
      session.userId = seedUser("Nora Nonadmin", role).id;
      expect(await expectRefusal(loadRefundRequests())).toBe(403);
    }
  );

  it("refuses nobody signed in with 401", async () => {
    expect(await expectRefusal(loadRefundRequests())).toBe(401);
  });
});

describe("the Refund Requests entry in the admin navigation", () => {
  async function loadAppLayout() {
    const { loader } = await import("./layout.app");
    const url = new URL("http://localhost/dashboard");
    return loader({
      request: new Request(url),
      url,
      pattern: "/",
      params: {},
      context: new RouterContextProvider(),
    });
  }

  function seedRefundRequestsWithStatuses(
    statuses: schema.RefundRequestStatus[]
  ) {
    const learner = seedUser("Ana Souza", schema.UserRole.Student);
    const { course } = seedCourse("Advanced TypeScript", 4900);
    for (const status of statuses) {
      const purchase = seedPurchase({
        userId: learner.id,
        courseId: course.id,
        amountPaid: 4900,
        createdAt: "2026-11-01T09:00:00.000Z",
      });
      seedRefundRequest({
        purchaseId: purchase.id,
        requestedAt: "2026-11-02T09:00:00.000Z",
        status,
      });
    }
  }

  it("shows an Admin how many Refund Requests are open", async () => {
    signInAsAdmin();
    seedRefundRequestsWithStatuses([
      schema.RefundRequestStatus.Requested,
      schema.RefundRequestStatus.Requested,
      schema.RefundRequestStatus.Approved,
      schema.RefundRequestStatus.Declined,
    ]);

    const { openRefundRequestCount } = await loadAppLayout();

    expect(openRefundRequestCount).toBe(2);
  });

  it("tells nobody but an Admin about open Refund Requests", async () => {
    seedRefundRequestsWithStatuses([schema.RefundRequestStatus.Requested]);
    session.userId = seedUser("Olga Instructor", schema.UserRole.Instructor).id;

    const { openRefundRequestCount } = await loadAppLayout();

    expect(openRefundRequestCount).toBeNull();
  });
});
