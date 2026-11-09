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

/** Runs the loader or action, expecting it to throw a `data(...)` refusal. */
async function expectRefusal(promise: Promise<unknown>) {
  const thrown = await promise.then(
    () => {
      throw new Error("Expected a refusal, but it succeeded");
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

// ─── Approving ───

let loggedLines: string[];

function captureLog() {
  loggedLines = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    loggedLines.push(String(line));
  });
}

async function submitResolution(fields: Record<string, string>) {
  const { action } = await import("./admin.refund-requests");
  const url = new URL("http://localhost/admin/refund-requests");
  return action({
    request: new Request(url, {
      method: "POST",
      body: new URLSearchParams(fields),
    }),
    url,
    pattern: "/admin/refund-requests",
    params: {},
    context: new RouterContextProvider(),
  });
}

function approve(refundRequestId: number) {
  return submitResolution({
    intent: "approve",
    refundRequestId: String(refundRequestId),
  });
}

/** Ana bought Advanced TypeScript, is enrolled, and asked for a Refund. */
function seedOpenRefundRequest(
  input: { purchasedAt?: string; requestedAt?: string } = {}
) {
  const purchasedAt = input.purchasedAt ?? "2026-11-01T09:00:00.000Z";
  const ana = seedUser("Ana Souza", schema.UserRole.Student);
  const { course, lessonIds } = seedCourse("Advanced TypeScript", 4900, 2);
  const purchase = seedPurchase({
    userId: ana.id,
    courseId: course.id,
    amountPaid: 4900,
    createdAt: purchasedAt,
  });
  db.insert(schema.enrollments)
    .values({ userId: ana.id, courseId: course.id, enrolledAt: purchasedAt })
    .run();
  const refundRequest = seedRefundRequest({
    purchaseId: purchase.id,
    requestedAt: input.requestedAt ?? "2026-11-05T10:00:00.000Z",
  });
  return { ana, course, lessonIds, refundRequest };
}

function findRefundRequest(id: number) {
  return db
    .select()
    .from(schema.refundRequests)
    .all()
    .find((row) => row.id === id);
}

function enrollmentsOf(userId: number) {
  return db
    .select()
    .from(schema.enrollments)
    .all()
    .filter((row) => row.userId === userId);
}

describe("approving a Refund Request", () => {
  beforeEach(captureLog);

  it("records the Refund: approved, the Refundable Amount, who approved it and when", async () => {
    const admin = signInAsAdmin();
    const { refundRequest } = seedOpenRefundRequest();

    await approve(refundRequest.id);

    expect(findRefundRequest(refundRequest.id)).toMatchObject({
      status: "approved",
      amountRefunded: 4900,
      resolvedByUserId: admin.id,
      resolvedAt: TODAY.toISOString(),
    });
  });

  it("ends the learner's Enrollment without deleting it, so they lose lesson access", async () => {
    signInAsAdmin();
    const { ana, course, refundRequest } = seedOpenRefundRequest();

    await approve(refundRequest.id);

    expect(enrollmentsOf(ana.id)).toEqual([
      expect.objectContaining({
        courseId: course.id,
        enrolledAt: "2026-11-01T09:00:00.000Z",
        endedAt: TODAY.toISOString(),
      }),
    ]);

    session.userId = ana.id;
    const { getAccess } = await import("~/lib/access.server");
    const access = await getAccess(
      new Request("http://localhost/courses/advanced-typescript"),
      course.id
    );
    expect(access).toMatchObject({ enrolled: false, canViewContent: false });
  });

  it("emails the learner the Refund amount and that their access has ended", async () => {
    signInAsAdmin();
    const { refundRequest } = seedOpenRefundRequest();

    await approve(refundRequest.id);

    const logged = loggedLines.join("\n");
    expect(logged).toContain("to=ana@example.com");
    expect(logged).toContain(
      "subject=Refund approved: Advanced TypeScript"
    );
    expect(logged).toContain("Your Refund is $49.00.");
    expect(logged).toContain(
      'Your access to "Advanced TypeScript" has ended.'
    );
    expect(logged).toContain("outside Cadence");
  });

  it("answers a second approval with a conflict, and no second email or Cancellation", async () => {
    const firstAdmin = signInAsAdmin();
    const { ana, refundRequest } = seedOpenRefundRequest();
    await approve(refundRequest.id);
    const [endedEnrollment] = enrollmentsOf(ana.id);
    loggedLines = [];

    // Another Admin approves a moment later, a day on.
    vi.setSystemTime(new Date("2026-11-10T12:00:00.000Z"));
    session.userId = seedUser("Mia Admin", schema.UserRole.Admin).id;
    const result = await approve(refundRequest.id);

    expect(result).toMatchObject({
      data: { error: "This Refund Request is already resolved." },
      init: { status: 409 },
    });
    expect(findRefundRequest(refundRequest.id)).toMatchObject({
      resolvedByUserId: firstAdmin.id,
      resolvedAt: TODAY.toISOString(),
    });
    expect(enrollmentsOf(ana.id)).toEqual([endedEnrollment]);
    expect(loggedLines).toEqual([]);
  });

  it("approves after the learner's 14-day window has closed", async () => {
    signInAsAdmin();
    // Bought 30 days ago, asked on day 10, and only reviewed today.
    const { refundRequest } = seedOpenRefundRequest({
      purchasedAt: "2026-10-10T12:00:00.000Z",
      requestedAt: "2026-10-20T12:00:00.000Z",
    });

    await approve(refundRequest.id);

    expect(findRefundRequest(refundRequest.id)).toMatchObject({
      status: "approved",
      amountRefunded: 4900,
    });
  });

  it("refuses a missing Refund Request with 404", async () => {
    signInAsAdmin();

    expect(await expectRefusal(approve(999))).toBe(404);
  });

  it.each([schema.UserRole.Student, schema.UserRole.Instructor])(
    "refuses a %s with 403 and leaves the request open",
    async (role) => {
      const { refundRequest } = seedOpenRefundRequest();
      session.userId = seedUser("Nora Nonadmin", role).id;

      expect(await expectRefusal(approve(refundRequest.id))).toBe(403);
      expect(findRefundRequest(refundRequest.id)?.status).toBe("requested");
      expect(loggedLines).toEqual([]);
    }
  );

  it("moves the request from open to resolved on the screen", async () => {
    signInAsAdmin();
    const { refundRequest } = seedOpenRefundRequest();

    await approve(refundRequest.id);
    const { open, resolved } = await loadRefundRequests();

    expect(open).toEqual([]);
    expect(resolved).toEqual([
      expect.objectContaining({
        id: refundRequest.id,
        status: "approved",
        learner: { name: "Ana Souza" },
        refundAmount: 4900,
        resolvedBy: { name: "Luis Admin" },
      }),
    ]);
  });
});

// ─── Declining ───

function decline(refundRequestId: number, note: string) {
  return submitResolution({
    intent: "decline",
    refundRequestId: String(refundRequestId),
    note,
  });
}

const DECLINE_NOTE =
  "You have completed most of the course, so this purchase isn't refundable.";

describe("declining a Refund Request", () => {
  beforeEach(captureLog);

  it("records the decline: declined, the note, who declined it and when, and the Enrollment stays active", async () => {
    const admin = signInAsAdmin();
    const { ana, refundRequest } = seedOpenRefundRequest();

    await decline(refundRequest.id, DECLINE_NOTE);

    expect(findRefundRequest(refundRequest.id)).toMatchObject({
      status: "declined",
      declineNote: DECLINE_NOTE,
      amountRefunded: null,
      resolvedByUserId: admin.id,
      resolvedAt: TODAY.toISOString(),
    });
    expect(enrollmentsOf(ana.id)).toEqual([
      expect.objectContaining({ endedAt: null }),
    ]);
  });

  it("emails the learner the Admin's note", async () => {
    signInAsAdmin();
    const { refundRequest } = seedOpenRefundRequest();

    await decline(refundRequest.id, DECLINE_NOTE);

    const logged = loggedLines.join("\n");
    expect(logged).toContain("to=ana@example.com");
    expect(logged).toContain(
      "subject=Refund Request declined: Advanced TypeScript"
    );
    expect(logged).toContain(DECLINE_NOTE);
    expect(logged).not.toContain("access");
  });

  it.each(["", "   "])(
    "requires a note, and changes nothing without one (note %j)",
    async (note) => {
      signInAsAdmin();
      const { refundRequest } = seedOpenRefundRequest();

      const result = await decline(refundRequest.id, note);

      expect(result).toMatchObject({
        data: { error: "Write a note to the learner." },
        init: { status: 400 },
      });
      expect(findRefundRequest(refundRequest.id)).toMatchObject({
        status: "requested",
        declineNote: null,
        resolvedAt: null,
        resolvedByUserId: null,
      });
      expect(loggedLines).toEqual([]);
    }
  );

  it("answers a decline of an approved request with a conflict, and no email", async () => {
    const firstAdmin = signInAsAdmin();
    const { ana, refundRequest } = seedOpenRefundRequest();
    await approve(refundRequest.id);
    const [endedEnrollment] = enrollmentsOf(ana.id);
    loggedLines = [];

    session.userId = seedUser("Mia Admin", schema.UserRole.Admin).id;
    const result = await decline(refundRequest.id, DECLINE_NOTE);

    expect(result).toMatchObject({
      data: { error: "This Refund Request is already resolved." },
      init: { status: 409 },
    });
    expect(findRefundRequest(refundRequest.id)).toMatchObject({
      status: "approved",
      declineNote: null,
      resolvedByUserId: firstAdmin.id,
    });
    expect(enrollmentsOf(ana.id)).toEqual([endedEnrollment]);
    expect(loggedLines).toEqual([]);
  });

  it("answers a second decline with a conflict, keeping the first note", async () => {
    signInAsAdmin();
    const { refundRequest } = seedOpenRefundRequest();
    await decline(refundRequest.id, DECLINE_NOTE);
    loggedLines = [];

    const result = await decline(refundRequest.id, "A different note.");

    expect(result).toMatchObject({ init: { status: 409 } });
    expect(findRefundRequest(refundRequest.id)?.declineNote).toBe(
      DECLINE_NOTE
    );
    expect(loggedLines).toEqual([]);
  });

  it("refuses a missing Refund Request with 404", async () => {
    signInAsAdmin();

    expect(await expectRefusal(decline(999, DECLINE_NOTE))).toBe(404);
  });

  it.each([schema.UserRole.Student, schema.UserRole.Instructor])(
    "refuses a %s with 403 and leaves the request open",
    async (role) => {
      const { refundRequest } = seedOpenRefundRequest();
      session.userId = seedUser("Nora Nonadmin", role).id;

      expect(
        await expectRefusal(decline(refundRequest.id, DECLINE_NOTE))
      ).toBe(403);
      expect(findRefundRequest(refundRequest.id)?.status).toBe("requested");
      expect(loggedLines).toEqual([]);
    }
  );

  it("moves the request from open to resolved on the screen, with its note", async () => {
    signInAsAdmin();
    const { refundRequest } = seedOpenRefundRequest();

    await decline(refundRequest.id, DECLINE_NOTE);
    const { open, resolved } = await loadRefundRequests();

    expect(open).toEqual([]);
    expect(resolved).toEqual([
      expect.objectContaining({
        id: refundRequest.id,
        status: "declined",
        learner: { name: "Ana Souza" },
        refundAmount: null,
        declineNote: DECLINE_NOTE,
        resolvedBy: { name: "Luis Admin" },
        resolvedAt: TODAY.toISOString(),
      }),
    ]);
  });
});
