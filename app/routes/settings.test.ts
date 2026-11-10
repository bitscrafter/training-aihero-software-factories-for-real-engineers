import { RouterContextProvider } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as schema from "~/db/schema";
import { useFreshAppDatabase } from "~/test/setup";

// Acting as a signed-in user: the session reports whichever user id the test
// puts here.
const session = vi.hoisted(() => ({ userId: null as number | null }));
vi.mock("~/lib/session", () => ({
  getCurrentUserId: vi.fn(async () => session.userId),
}));

type Db = Awaited<ReturnType<typeof useFreshAppDatabase>>;

let db: Db;

beforeEach(async () => {
  db = await useFreshAppDatabase();
  session.userId = null;
  categoryId = undefined;
  instructorId = undefined;
});

function seedUser(name: string, role = schema.UserRole.Student) {
  const email = `${name.split(" ")[0].toLowerCase()}@example.com`;
  return db
    .insert(schema.users)
    .values({ name, email, role })
    .returning()
    .get();
}

let categoryId: number | undefined;
let instructorId: number | undefined;

function seedCourse(title: string, price = 10000) {
  instructorId ??= seedUser("Ida Instructor", schema.UserRole.Instructor).id;
  categoryId ??= db
    .insert(schema.categories)
    .values({ name: "Programming", slug: "programming" })
    .returning()
    .get().id;
  return db
    .insert(schema.courses)
    .values({
      title,
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      description: "A course",
      salesCopy: `## ${title}`,
      instructorId,
      categoryId,
      status: schema.CourseStatus.Published,
      price,
    })
    .returning()
    .get();
}

function seedRefundRequest(input: {
  userId: number;
  courseId: number;
  amountPaid: number;
  requestedAt: string;
  status?: schema.RefundRequestStatus;
  amountRefunded?: number;
  declineNote?: string;
  resolvedAt?: string;
  resolvedByUserId?: number;
}) {
  const { userId, courseId, amountPaid, ...request } = input;
  const purchase = db
    .insert(schema.purchases)
    .values({
      userId,
      courseId,
      amountPaid,
      country: "US",
      createdAt: "2026-11-01T10:00:00.000Z",
    })
    .returning()
    .get();
  return db
    .insert(schema.refundRequests)
    .values({ purchaseId: purchase.id, reason: "Not what I expected.", ...request })
    .returning()
    .get();
}

async function loadSettings() {
  const { loader } = await import("./settings");
  const url = new URL("http://localhost/settings");
  return loader({
    request: new Request(url),
    url,
    pattern: "/settings",
    params: {},
    context: new RouterContextProvider(),
  });
}

describe("settings loader: Refund Requests", () => {
  it("lists the student's open, approved and declined Refund Requests with the Refund amount or the decline note", async () => {
    const ana = seedUser("Ana Student");
    const admin = seedUser("Luis Admin", schema.UserRole.Admin);
    const typescript = seedCourse("Advanced TypeScript");
    const react = seedCourse("React Basics");
    const node = seedCourse("Node Internals");

    seedRefundRequest({
      userId: ana.id,
      courseId: typescript.id,
      amountPaid: 4900,
      requestedAt: "2026-11-02T10:00:00.000Z",
      status: schema.RefundRequestStatus.Approved,
      amountRefunded: 4900,
      resolvedAt: "2026-11-03T10:00:00.000Z",
      resolvedByUserId: admin.id,
    });
    seedRefundRequest({
      userId: ana.id,
      courseId: react.id,
      amountPaid: 2900,
      requestedAt: "2026-11-04T10:00:00.000Z",
      status: schema.RefundRequestStatus.Declined,
      declineNote: "You finished most of the course.",
      resolvedAt: "2026-11-05T10:00:00.000Z",
      resolvedByUserId: admin.id,
    });
    seedRefundRequest({
      userId: ana.id,
      courseId: node.id,
      amountPaid: 3900,
      requestedAt: "2026-11-06T10:00:00.000Z",
    });
    session.userId = ana.id;

    const { refundRequests } = await loadSettings();

    expect(refundRequests).toEqual([
      expect.objectContaining({
        courseTitle: "Node Internals",
        status: "requested",
        amountRefunded: null,
        declineNote: null,
      }),
      expect.objectContaining({
        courseTitle: "React Basics",
        status: "declined",
        amountRefunded: null,
        declineNote: "You finished most of the course.",
      }),
      expect.objectContaining({
        courseTitle: "Advanced TypeScript",
        status: "approved",
        amountRefunded: 4900,
        declineNote: null,
      }),
    ]);
  });

  it("shows the student only their own Refund Requests", async () => {
    const ana = seedUser("Ana Student");
    const ben = seedUser("Ben Student");
    const typescript = seedCourse("Advanced TypeScript");
    const react = seedCourse("React Basics");
    seedRefundRequest({
      userId: ana.id,
      courseId: typescript.id,
      amountPaid: 4900,
      requestedAt: "2026-11-02T10:00:00.000Z",
    });
    seedRefundRequest({
      userId: ben.id,
      courseId: react.id,
      amountPaid: 2900,
      requestedAt: "2026-11-03T10:00:00.000Z",
    });
    session.userId = ana.id;

    const { refundRequests } = await loadSettings();

    expect(refundRequests.map((r) => r.courseTitle)).toEqual([
      "Advanced TypeScript",
    ]);
  });
});
