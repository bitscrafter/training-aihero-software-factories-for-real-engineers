import { data, redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/courses.$slug.refund-request";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import {
  courses,
  refundRequests,
  users,
  RefundRequestStatus,
} from "~/db/schema";
import { eq } from "drizzle-orm";
import { parseFormData, parseParams } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import { checkRefundEligibility } from "~/lib/refund-eligibility";
import { getRefundFacts } from "~/lib/refund-eligibility.server";
import { isEnrolled } from "~/lib/enrollment.server";

const refundRequestParamsSchema = z.object({
  slug: z.string().min(1),
});

const refundRequestFormSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Tell us a little more about why you want a refund.")
    .max(1000, "Please keep your reason under 1000 characters."),
});

function getCourseBySlug(slug: string) {
  return db.select().from(courses).where(eq(courses.slug, slug)).get();
}

/**
 * The confirmation the student gets in their inbox. There is no mail
 * transport wired up yet, so the built message goes to the server log.
 */
function buildRefundRequestEmail(input: {
  studentName: string;
  studentEmail: string;
  courseTitle: string;
  amount: number;
}) {
  return {
    to: input.studentEmail,
    subject: `Refund request received: ${input.courseTitle}`,
    body: [
      `Hi ${input.studentName},`,
      "",
      `We have your refund request for "${input.courseTitle}".`,
      `If it is approved, your refund will be ${formatPrice(input.amount)}.`,
      "",
      "Our team reviews every refund request by hand. You do not need to do anything else — we will email you again when it is done.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("You must be logged in to request a refund.", { status: 401 });
  }

  const { slug } = parseParams(params, refundRequestParamsSchema);
  const course = getCourseBySlug(slug);

  if (!course) {
    throw data("Course not found", { status: 404 });
  }

  const student = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!student) {
    throw data("User not found", { status: 404 });
  }

  const refundFacts = getRefundFacts(currentUserId, course);

  if (!refundFacts) {
    throw data("You have not bought this course.", { status: 403 });
  }

  // Matches the course page, which only offers the form to enrolled students.
  // A Team Admin (no Enrollment of their own) or a refunded student (ended
  // Enrollment) is refused. Interim policy for team purchases until #8.
  if (!isEnrolled(currentUserId, course.id)) {
    throw data("You are not enrolled in this course.", { status: 403 });
  }

  const eligibility = checkRefundEligibility(refundFacts.facts, new Date());

  if (!eligibility.eligible) {
    // A purchase gets at most one Refund Request: asking again is a conflict.
    const status =
      eligibility.failedRule === "openRefundRequest" ||
      eligibility.failedRule === "resolvedRefundRequest"
        ? 409
        : 403;
    throw data(eligibility.message, { status });
  }

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundRequestFormSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  db.insert(refundRequests)
    .values({
      purchaseId: refundFacts.purchaseId,
      status: RefundRequestStatus.Requested,
      reason: parsed.data.reason,
    })
    .returning()
    .get();

  const email = buildRefundRequestEmail({
    studentName: student.name,
    studentEmail: student.email,
    courseTitle: course.title,
    amount: eligibility.refundableAmount,
  });

  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);

  return redirect("/settings");
}
