import { useState } from "react";
import { data, isRouteErrorResponse, Link, useFetcher } from "react-router";
import { eq } from "drizzle-orm";
import { AlertTriangle } from "lucide-react";
import type { Route } from "./+types/admin.refund-requests";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import { RefundRequestStatus, UserRole, users } from "~/db/schema";
import { z } from "zod";
import {
  approveRefundRequest,
  declineRefundRequest,
  getOpenRefundRequests,
  getResolvedRefundRequests,
} from "~/lib/refund-requests.server";
import { REFUND_REQUEST_STATUS_LABELS } from "~/lib/refund-requests";
import { parseFormData } from "~/lib/validation";
import { daysSince, formatPrice } from "~/lib/utils";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    {
      name: "description",
      content: "Review open and resolved Refund Requests",
    },
  ];
}

function getUserById(id: number) {
  return db.select().from(users).where(eq(users.id, id)).get();
}

/** Throws 401 or 403 unless an Admin is signed in. Returns the Admin. */
async function requireAdmin(request: Request) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data(
      "Select a user from the DevUI panel to review Refund Requests.",
      {
        status: 401,
      }
    );
  }

  const currentUser = getUserById(currentUserId);

  if (!currentUser || currentUser.role !== UserRole.Admin) {
    throw data("Only Admins can access this page.", { status: 403 });
  }

  return currentUser;
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);

  return {
    open: getOpenRefundRequests(),
    resolved: getResolvedRefundRequests(),
  };
}

const refundRequestId = z.coerce.number().int().positive();

const resolutionFormSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("approve"), refundRequestId }),
  z.object({
    intent: z.literal("decline"),
    refundRequestId,
    note: z.string().trim().min(1, "Write a note to the learner."),
  }),
]);

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request);

  const parsed = parseFormData(await request.formData(), resolutionFormSchema);
  if (!parsed.success) {
    // A missing decline note is the one mistake an Admin can fix in the form.
    if (parsed.errors.note) {
      return data({ error: parsed.errors.note }, { status: 400 });
    }
    throw data("Invalid form submission.", { status: 400 });
  }

  const form = parsed.data;
  const result =
    form.intent === "approve"
      ? approveRefundRequest(form.refundRequestId, admin.id)
      : declineRefundRequest(form.refundRequestId, admin.id, form.note);

  if (result.outcome === "notFound") {
    throw data("Refund Request not found.", { status: 404 });
  }

  if (result.outcome === "alreadyResolved") {
    throw data("This Refund Request is already resolved.", { status: 409 });
  }

  if (result.outcome === "approved") {
    logEmail(
      buildRefundApprovedEmail({
        learnerName: result.learner.name,
        learnerEmail: result.learner.email,
        courseTitle: result.courseTitle,
        amount: result.amountRefunded,
      })
    );
  }

  if (result.outcome === "declined") {
    logEmail(
      buildRefundDeclinedEmail({
        learnerName: result.learner.name,
        learnerEmail: result.learner.email,
        courseTitle: result.courseTitle,
        note: result.note,
      })
    );
  }

  return { error: null };
}

type Email = { to: string; subject: string; body: string };

// There is no mail transport wired up yet, so built emails go to the server log.
function logEmail(email: Email) {
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);
}

/** A learner email: the greeting, the given paragraphs, and the sign-off. */
function buildLearnerEmail(input: {
  learnerName: string;
  learnerEmail: string;
  subject: string;
  paragraphs: string[][];
}): Email {
  return {
    to: input.learnerEmail,
    subject: input.subject,
    body: [
      [`Hi ${input.learnerName},`],
      ...input.paragraphs,
      ["— The Cadence team"],
    ]
      .map((lines) => lines.join("\n"))
      .join("\n\n"),
  };
}

/** The email a learner gets when their Refund Request is declined. */
function buildRefundDeclinedEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  note: string;
}) {
  return buildLearnerEmail({
    ...input,
    subject: `Refund Request declined: ${input.courseTitle}`,
    paragraphs: [
      [
        `We have declined your Refund Request for "${input.courseTitle}".`,
        "Here is the note from the Admin who reviewed it:",
      ],
      [input.note],
    ],
  });
}

/** The email a learner gets when their Refund Request is approved. */
function buildRefundApprovedEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amount: number;
}) {
  return buildLearnerEmail({
    ...input,
    subject: `Refund approved: ${input.courseTitle}`,
    paragraphs: [
      [
        `We have approved your Refund Request for "${input.courseTitle}".`,
        `Your Refund is ${formatPrice(input.amount)}.`,
        `Your access to "${input.courseTitle}" has ended.`,
      ],
      [
        "We return the money to you outside Cadence, so you will not see it in your Cadence account.",
      ],
    ],
  });
}

// "YYYY-MM-DD" from an ISO timestamp.
function formatDay(iso: string) {
  return iso.slice(0, 10);
}

function formatWatchTime(seconds: number) {
  const totalMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = String(totalMinutes % 60).padStart(2, "0");
  return `${hours}h ${minutes}m`;
}

function formatRequestedAgo(iso: string) {
  const days = daysSince(iso);
  if (days === 0) return "requested today";
  return `requested ${days} day${days === 1 ? "" : "s"} ago`;
}

type OpenRefundRequest = Route.ComponentProps["loaderData"]["open"][number];
type ResolvedRefundRequest =
  Route.ComponentProps["loaderData"]["resolved"][number];

function ApproveRefundRequestButton({
  request,
}: {
  request: OpenRefundRequest;
}) {
  const fetcher = useFetcher<typeof action>();
  const amount = formatPrice(request.refundAmount);
  const firstName = request.learner.name.split(" ")[0];

  return (
    <fetcher.Form
      method="post"
      onSubmit={(event) => {
        const confirmed = confirm(
          `Refund ${amount} and end ${firstName}'s access to ${request.courseTitle}?`
        );
        if (!confirmed) event.preventDefault();
      }}
    >
      <input type="hidden" name="intent" value="approve" />
      <input type="hidden" name="refundRequestId" value={request.id} />
      <Button type="submit" size="sm" disabled={fetcher.state !== "idle"}>
        Approve {amount}
      </Button>
    </fetcher.Form>
  );
}

/**
 * "Decline…" opens an inline form for the note to the learner, which is
 * required. Cancel closes it without changing anything.
 */
function DeclineRefundRequestForm({
  request,
  onCancel,
}: {
  request: OpenRefundRequest;
  onCancel: () => void;
}) {
  const fetcher = useFetcher<typeof action>();
  const noteId = `decline-note-${request.id}`;
  const error = fetcher.data?.error;

  return (
    <fetcher.Form method="post" className="w-full space-y-2">
      <input type="hidden" name="intent" value="decline" />
      <input type="hidden" name="refundRequestId" value={request.id} />
      <Label htmlFor={noteId}>Note to {request.learner.name}</Label>
      <Textarea
        id={noteId}
        name="note"
        required
        rows={3}
        placeholder="Explain why this Refund Request is declined."
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          variant="destructive"
          disabled={fetcher.state !== "idle"}
        >
          Decline Refund Request
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </fetcher.Form>
  );
}

function OpenRefundRequestCard({ request }: { request: OpenRefundRequest }) {
  const [declining, setDeclining] = useState(false);

  return (
    <Card>
      <CardContent className="space-y-1 p-4 text-sm">
        <div className="flex items-baseline justify-between gap-4">
          <div className="font-medium">
            {request.learner.name}{" "}
            <span className="text-muted-foreground">
              · {request.learner.email}
            </span>
          </div>
          <div
            className="shrink-0 text-muted-foreground"
            suppressHydrationWarning
          >
            {formatRequestedAgo(request.requestedAt)}
          </div>
        </div>
        <div className="font-medium">{request.courseTitle}</div>
        <div className="text-muted-foreground">
          Bought {formatDay(request.purchasedAt)} · Paid{" "}
          {formatPrice(request.amountPaid)} · Refund{" "}
          <span className="font-medium text-foreground">
            {formatPrice(request.refundAmount)}
          </span>
        </div>
        <div className="text-muted-foreground">
          Watched {formatWatchTime(request.secondsWatched)} ·{" "}
          {request.lessonsCompleted} of {request.totalLessons} lessons completed
        </div>
        <blockquote className="pt-1 italic">"{request.reason}"</blockquote>
        <div className="flex items-start gap-2 pt-2">
          {declining ? (
            <DeclineRefundRequestForm
              request={request}
              onCancel={() => setDeclining(false)}
            />
          ) : (
            <>
              <ApproveRefundRequestButton request={request} />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setDeclining(true)}
              >
                Decline…
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ResolvedRefundRequestRow({
  request,
}: {
  request: ResolvedRefundRequest;
}) {
  const approved = request.status === RefundRequestStatus.Approved;
  return (
    <li className="flex items-baseline justify-between gap-4 py-2 text-sm">
      <div>
        <span className="mr-3 inline-block w-20 font-medium">
          {REFUND_REQUEST_STATUS_LABELS[request.status]}
        </span>
        {request.learner.name} · {request.courseTitle}
        {approved && request.refundAmount !== null && (
          <> · {formatPrice(request.refundAmount)}</>
        )}
        {!approved && request.declineNote && (
          <p className="mt-1 pl-23 whitespace-pre-line text-muted-foreground italic">
            "{request.declineNote}"
          </p>
        )}
      </div>
      <div className="shrink-0 text-muted-foreground">
        by {request.resolvedBy?.name ?? "unknown"}
        {request.resolvedAt && <> · {formatDay(request.resolvedAt)}</>}
      </div>
    </li>
  );
}

export default function AdminRefundRequests({
  loaderData,
}: Route.ComponentProps) {
  const { open, resolved } = loaderData;

  return (
    <div className="mx-auto max-w-4xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Refund Requests</span>
      </nav>

      <h1 className="mb-8 text-3xl font-bold">Refund Requests</h1>

      <section className="mb-10">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Open ({open.length})</h2>
          <span className="text-sm text-muted-foreground">oldest first</span>
        </div>
        {open.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No open Refund Requests.
          </p>
        ) : (
          <div className="space-y-3">
            {open.map((request) => (
              <OpenRefundRequestCard key={request.id} request={request} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Resolved</h2>
        {resolved.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No resolved Refund Requests yet.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {resolved.map((request) => (
              <ResolvedRefundRequestRow key={request.id} request={request} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading Refund Requests.";
  // Signed-out and non-Admin visitors go home; an Admin goes back to the list.
  let backLink = {
    to: "/admin/refund-requests",
    label: "Back to Refund Requests",
  };

  if (isRouteErrorResponse(error)) {
    if (error.status === 401 || error.status === 403) {
      backLink = { to: "/", label: "Go Home" };
    }
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message =
        typeof error.data === "string"
          ? error.data
          : "Only Admins can access this page.";
    } else if (error.status === 409) {
      title = "Already resolved";
      message =
        typeof error.data === "string"
          ? error.data
          : "This Refund Request is already resolved.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to={backLink.to}>
          <Button>{backLink.label}</Button>
        </Link>
      </div>
    </div>
  );
}
