import { RefundRequestStatus } from "~/db/schema";

/** How a Refund Request's status reads on screen, to Admins and learners. */
export const REFUND_REQUEST_STATUS_LABELS: Record<RefundRequestStatus, string> =
  {
    [RefundRequestStatus.Requested]: "Pending",
    [RefundRequestStatus.Approved]: "Approved",
    [RefundRequestStatus.Declined]: "Declined",
  };
