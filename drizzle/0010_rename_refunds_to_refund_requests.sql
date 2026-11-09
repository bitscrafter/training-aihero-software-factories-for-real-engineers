-- Rename in place, so existing Refund Requests survive.
ALTER TABLE `refunds` RENAME TO `refund_requests`;--> statement-breakpoint
DROP INDEX IF EXISTS `refunds_purchase_idx`;--> statement-breakpoint
CREATE INDEX `refund_requests_purchase_idx` ON `refund_requests` (`purchase_id`);
