import { RouterContextProvider } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as schema from "~/db/schema";
import { useFreshAppDatabase } from "~/test/setup";

// Acting as a signed-in student: the session reports whichever user id the
// test puts here. The country comes from neither the session nor a header.
const session = vi.hoisted(() => ({ userId: null as number | null }));
vi.mock("~/lib/session", () => ({
  getCurrentUserId: vi.fn(async () => session.userId),
  getSession: vi.fn(async () => ({ get: () => undefined })),
}));

type Db = Awaited<ReturnType<typeof useFreshAppDatabase>>;

let db: Db;

beforeEach(async () => {
  db = await useFreshAppDatabase();
  session.userId = null;
});

function seedCourse(slug: string) {
  const instructor = db
    .insert(schema.users)
    .values({
      name: `Instructor of ${slug}`,
      email: `${slug}-instructor@example.com`,
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
      title: `Course ${slug}`,
      slug,
      description: "A course",
      salesCopy: "## A course",
      instructorId: instructor.id,
      categoryId: category.id,
      status: schema.CourseStatus.Published,
      price: 4900,
    })
    .returning()
    .get();
}

/** A signed-in student, not enrolled in anything. */
function seedSignedInStudent() {
  const student = db
    .insert(schema.users)
    .values({
      name: "Lena Learner",
      email: "lena@example.com",
      role: schema.UserRole.Student,
    })
    .returning()
    .get();
  session.userId = student.id;
  return student;
}

/** Earlier purchases of the course, each with a resolved Refund Request. */
function seedRefundRequests(
  userId: number,
  courseId: number,
  statuses: schema.RefundRequestStatus[]
) {
  for (const status of statuses) {
    const purchase = db
      .insert(schema.purchases)
      .values({ userId, courseId, amountPaid: 4900, country: "US" })
      .returning()
      .get();
    db.insert(schema.refundRequests)
      .values({
        purchaseId: purchase.id,
        status,
        reason: "The course was not what I expected.",
        amountRefunded:
          status === schema.RefundRequestStatus.Approved ? 4900 : null,
        resolvedAt: "2026-01-02T12:00:00.000Z",
      })
      .run();
  }
}

async function loadPurchasePage(slug: string) {
  const { loader } = await import("./courses.$slug.purchase");
  const url = new URL(`http://localhost/courses/${slug}/purchase`);
  return loader({
    request: new Request(url),
    url,
    pattern: "/courses/:slug/purchase",
    params: { slug },
    context: new RouterContextProvider(),
  });
}

const { Approved, Declined } = schema.RefundRequestStatus;

describe("the purchase page's Refund limit warning", () => {
  it("warns a student who has had 3 Refunds for the course", async () => {
    const course = seedCourse("testing-things");
    const student = seedSignedInStudent();
    seedRefundRequests(student.id, course.id, [Approved, Approved, Approved]);

    const loaded = await loadPurchasePage("testing-things");

    expect(loaded.refundLimitWarning).toBe(
      "You have already had 3 Refunds for this course, so this purchase can't be refunded."
    );
  });

  it("does not warn below the limit, with declined requests not counting", async () => {
    const course = seedCourse("testing-things");
    const student = seedSignedInStudent();
    seedRefundRequests(student.id, course.id, [Approved, Approved, Declined]);

    const loaded = await loadPurchasePage("testing-things");

    expect(loaded.refundLimitWarning).toBeNull();
  });

  it("does not count Refunds for other courses", async () => {
    seedCourse("testing-things");
    const other = seedCourse("other-things");
    const student = seedSignedInStudent();
    seedRefundRequests(student.id, other.id, [Approved, Approved, Approved]);

    const loaded = await loadPurchasePage("testing-things");

    expect(loaded.refundLimitWarning).toBeNull();
  });
});
