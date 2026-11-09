import { data, isRouteErrorResponse, Link } from "react-router";
import { eq } from "drizzle-orm";
import { AlertTriangle } from "lucide-react";
import type { Route } from "./+types/admin.refund-requests";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import { RefundRequestStatus, UserRole, users } from "~/db/schema";
import {
  getOpenRefundRequests,
  getResolvedRefundRequests,
} from "~/lib/refund-requests.server";
import { daysSince, formatPrice } from "~/lib/utils";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    { name: "description", content: "Review open and resolved Refund Requests" },
  ];
}

function getUserById(id: number) {
  return db.select().from(users).where(eq(users.id, id)).get();
}

export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to review Refund Requests.", {
      status: 401,
    });
  }

  const currentUser = getUserById(currentUserId);

  if (!currentUser || currentUser.role !== UserRole.Admin) {
    throw data("Only Admins can access this page.", { status: 403 });
  }

  return {
    open: getOpenRefundRequests(),
    resolved: getResolvedRefundRequests(),
  };
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

function OpenRefundRequestCard({ request }: { request: OpenRefundRequest }) {
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
          <div className="shrink-0 text-muted-foreground" suppressHydrationWarning>
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
          {request.lessonsCompleted} of {request.totalLessons} lessons
          completed
        </div>
        <blockquote className="pt-1 italic">"{request.reason}"</blockquote>
        {/* Approve and Decline actions arrive with #13 and #16. */}
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
          {approved ? "Approved" : "Declined"}
        </span>
        {request.learner.name} · {request.courseTitle}
        {approved && request.refundAmount !== null && (
          <> · {formatPrice(request.refundAmount)}</>
        )}
        {/* The decline note shows here once declining exists (#16). */}
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

  if (isRouteErrorResponse(error)) {
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
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
